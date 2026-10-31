import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { historyEvents } from "../../../src/core/history-import.ts";
import type { LegacyHistory } from "../../../src/core/history-import.ts";

self.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
  try {
    const bytes = new Uint8Array(data);
    if (bytes.length < 100 || new TextDecoder().decode(bytes.subarray(0, 16)) !== "SQLite format 3\0") throw new Error("Choose a SQLite history database");
    // SQLite's in-memory deserializer cannot open WAL mode; the selected file must be checkpointed by quitting the Mac app first.
    if (bytes[18] === 2 && bytes[19] === 2) { bytes[18] = 1; bytes[19] = 1; }
    const sqlite = await sqlite3InitModule();
    const db = new sqlite.oo1.DB(":memory:");
    try {
      const memory = sqlite.wasm.allocFromTypedArray(bytes);
      const result = sqlite.capi.sqlite3_deserialize(db.pointer!, "main", memory, bytes.length, bytes.length,
        sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_READONLY);
      if (result !== sqlite.capi.SQLITE_OK) throw new Error(`Could not open history database (${result})`);
      if (db.selectValue("PRAGMA integrity_check") !== "ok") throw new Error("The history database is damaged");
      const versions = db.selectValues("SELECT version FROM metadata");
      if (versions.length !== 1 || versions[0] !== 1) throw new Error("Unsupported Mac app history version");
      const rows = (sql: string) => db.exec({ sql, rowMode: "object", returnValue: "resultRows" }) as Record<string, unknown>[];
      const history: LegacyHistory = {
        attempts: rows("SELECT id, created_at, inputs, assessment, excluded FROM attempts ORDER BY created_at, rowid"),
        tasks: rows("SELECT id, created_at, task, fingerprint, completed FROM tasks ORDER BY created_at, rowid"),
        pieces: rows("SELECT id, piece FROM pieces ORDER BY rowid"),
        songs: rows("SELECT id, created_at, song FROM songs ORDER BY created_at, rowid"),
        song_plays: rows("SELECT id, song_id, created_at, play FROM song_plays ORDER BY created_at, rowid"),
      };
      self.postMessage({ events: historyEvents(history), counts: Object.fromEntries(Object.entries(history).map(([key, value]) => [key, value.length])) });
    } finally { db.close(); }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
