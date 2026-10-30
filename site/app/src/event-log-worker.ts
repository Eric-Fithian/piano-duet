import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { canonicalJson, validateEvent } from "./events";
import type { EventKind, JsonValue, PracticeEvent } from "./events";

type Request =
  | { id: number; action: "open" | "list" | "close" }
  | { id: number; action: "append"; kind: EventKind; payload: JsonValue; eventId?: string }
  | { id: number; action: "merge"; events: PracticeEvent[] };

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
  if (version !== 0 && version !== 1) throw new Error(`Unsupported database version: ${version}`);
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
    PRAGMA user_version = 1;
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

function list(): PracticeEvent[] {
  return db().exec({ sql: "SELECT id, device_id, clock, created_at, kind, payload FROM events ORDER BY clock, device_id, id",
    rowMode: "object", returnValue: "resultRows" }).map((row) => ({
    id: String(row.id), deviceId: String(row.device_id), clock: Number(row.clock), createdAt: String(row.created_at),
    kind: row.kind as EventKind, payload: JSON.parse(String(row.payload)) as JsonValue,
  }));
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    let value: unknown;
    if (data.action === "open") value = await open();
    else if (data.action === "append") value = append(data.kind, data.payload, data.eventId);
    else if (data.action === "merge") value = merge(data.events);
    else if (data.action === "list") value = list();
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
