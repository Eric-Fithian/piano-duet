import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { canonicalJson, validateEvent } from "./events";
import type { EventKind, JsonValue, PracticeEvent } from "./events";

type Request =
  | { id: number; action: "open" | "list" | "close" }
  | { id: number; action: "append"; kind: EventKind; payload: JsonValue; eventId?: string }
  | { id: number; action: "merge"; events: PracticeEvent[] }
  | { id: number; action: "unsynced"; userId: string; limit: number }
  | { id: number; action: "acknowledge"; userId: string; ids: string[] }
  | { id: number; action: "cursor"; userId: string }
  | { id: number; action: "applyRemote"; userId: string; events: PracticeEvent[]; cursor: number };

let database: Database | undefined;
let pool: SAHPoolUtil | undefined;
let deviceId: string;

async function open(): Promise<{ deviceId: string }> {
  if (database) return { deviceId };
  Object.assign(globalThis, { sqlite3ApiConfig: { disable: { vfs: { opfs: true, "opfs-wl": true, kvvfs: true } } } });
  const sqlite = await sqlite3InitModule();
  pool = await sqlite.installOpfsSAHPoolVfs({ name: "piano-duet", directory: "/piano-duet-sqlite", preserveOnInitFailure: true });
  database = new pool.OpfsSAHPoolDb("/practice.sqlite3");
  const version = database.selectValue("PRAGMA user_version");
  if (version !== 0 && version !== 1 && version !== 2) throw new Error(`Unsupported database version: ${version}`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS device (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL,
      clock INTEGER NOT NULL CHECK(clock > 0), created_at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('attempt', 'song', 'edit', 'exclusion', 'setting')),
      payload TEXT NOT NULL CHECK(json_valid(payload))
    );
    CREATE INDEX IF NOT EXISTS event_order ON events(clock, device_id, id);
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
    CREATE TABLE IF NOT EXISTS sync_ack (user_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), PRIMARY KEY(user_id, event_id));
    CREATE TABLE IF NOT EXISTS sync_cursor (user_id TEXT PRIMARY KEY NOT NULL, sequence INTEGER NOT NULL CHECK(sequence >= 0));
    PRAGMA user_version = 2;
  `);
  const rows = database.selectValues("SELECT id FROM device");
  if (rows.length > 1) throw new Error("More than one local device identity");
  deviceId = rows.length ? String(rows[0]) : crypto.randomUUID();
  if (!rows.length) database.exec({ sql: "INSERT INTO device(id) VALUES (?)", bind: [deviceId] });
  return { deviceId };
}

function db(): Database {
  if (!database) throw new Error("The event log is not open");
  return database;
}

function insert(event: PracticeEvent): boolean {
  validateEvent(event);
  const payload = canonicalJson(event.payload);
  const existing = db().selectObject("SELECT device_id, clock, created_at, kind, payload FROM events WHERE id = ?", [event.id]);
  if (existing) {
    if (existing.device_id !== event.deviceId || existing.clock !== event.clock || existing.created_at !== event.createdAt
        || existing.kind !== event.kind || existing.payload !== payload) throw new Error(`Conflicting event ${event.id}`);
    return false;
  }
  db().exec({ sql: "INSERT INTO events(id, device_id, clock, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)",
    bind: [event.id, event.deviceId, event.clock, event.createdAt, event.kind, payload] });
  return true;
}

function append(kind: EventKind, payload: JsonValue, eventId?: string): PracticeEvent {
  return db().transaction("IMMEDIATE", () => {
    const clock = Number(db().selectValue("SELECT COALESCE(MAX(clock), 0) FROM events")) + 1;
    const event = { id: eventId ?? crypto.randomUUID(), deviceId, clock, createdAt: new Date().toISOString(), kind, payload };
    insert(event);
    return event;
  });
}

function merge(events: PracticeEvent[]): number {
  return db().transaction("IMMEDIATE", () => events.reduce((count, event) => count + Number(insert(event)), 0));
}

function rows(sql: string, bind: (string | number)[] = []): PracticeEvent[] {
  return db().exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }).map((row) => ({
    id: String(row.id), deviceId: String(row.device_id), clock: Number(row.clock), createdAt: String(row.created_at),
    kind: row.kind as EventKind, payload: JSON.parse(String(row.payload)) as JsonValue,
  }));
}

function list(): PracticeEvent[] {
  return rows("SELECT id, device_id, clock, created_at, kind, payload FROM events ORDER BY clock, device_id, id");
}

function acknowledge(userId: string, ids: string[]): void {
  for (const id of ids) db().exec({ sql: "INSERT OR IGNORE INTO sync_ack(user_id, event_id) VALUES (?, ?)", bind: [userId, id] });
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    let value: unknown;
    if (data.action === "open") value = await open();
    else if (data.action === "append") value = append(data.kind, data.payload, data.eventId);
    else if (data.action === "merge") value = merge(data.events);
    else if (data.action === "list") value = list();
    else if (data.action === "unsynced") value = rows("SELECT e.id, e.device_id, e.clock, e.created_at, e.kind, e.payload FROM events e WHERE NOT EXISTS (SELECT 1 FROM sync_ack a WHERE a.user_id = ? AND a.event_id = e.id) ORDER BY e.clock, e.device_id, e.id LIMIT ?", [data.userId, data.limit]);
    else if (data.action === "acknowledge") value = db().transaction("IMMEDIATE", () => acknowledge(data.userId, data.ids));
    else if (data.action === "cursor") value = Number(db().selectValue("SELECT COALESCE((SELECT sequence FROM sync_cursor WHERE user_id = ?), 0)", [data.userId]));
    else if (data.action === "applyRemote") value = db().transaction("IMMEDIATE", () => {
      const previous = Number(db().selectValue("SELECT COALESCE((SELECT sequence FROM sync_cursor WHERE user_id = ?), 0)", [data.userId]));
      if (!Number.isSafeInteger(data.cursor) || data.cursor < previous) throw new Error("Invalid sync cursor");
      const added = data.events.reduce((count, event) => count + Number(insert(event)), 0);
      acknowledge(data.userId, data.events.map((event) => event.id));
      db().exec({ sql: "INSERT INTO sync_cursor(user_id, sequence) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET sequence = excluded.sequence", bind: [data.userId, data.cursor] });
      return added;
    });
    else if (data.action === "close") {
      db().close();
      database = undefined;
      pool?.pauseVfs();
      value = null;
    } else throw new Error("Unknown event log operation");
    self.postMessage({ id: data.id, value });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
