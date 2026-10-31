import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { historyEvents } from "../../src/core/history-import.ts";
import type { LegacyHistory } from "../../src/core/history-import.ts";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalEventStore } from "../../src/core/local-service.ts";

test("Mac app history rebuilds the Python profile, drills, songs and saved pieces", async () => {
  mkdirSync(".local", { recursive: true });
  const directory = mkdtempSync(".local/history-parity-");
  try {
    const path = `${directory}/learner.sqlite3`;
    const fixture = spawnSync("uv", ["run", "--frozen", "python", "tests/core/history_fixture.py", path], { encoding: "utf8", timeout: 300_000, maxBuffer: 20_000_000 });
    assert.equal(fixture.status, 0, fixture.stderr);
    const expected = JSON.parse(fixture.stdout);
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = (table: string, order: string) => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    const history = { attempts: rows("attempts", "created_at, rowid"), tasks: rows("tasks", "created_at, rowid"),
      pieces: rows("pieces", "rowid"), songs: rows("songs", "created_at, rowid"), song_plays: rows("song_plays", "created_at, rowid") } as LegacyHistory;
    db.close();
    const events = historyEvents(history);
    const store: LocalEventStore = { async list() { return events; } };
    const service = new LocalService(store, undefined, () => expected.profile.generated_at);
    for (const endpoint of ["profile", "drills", "library", "pieces"]) {
      const actual = await (await service.fetch(`/api/${endpoint}`)).json();
      assert.deepEqual(actual, expected[endpoint], endpoint);
    }
    assert.deepEqual(await (await service.fetch(`/api/library/${expected.song.id}`)).json(), expected.song);
    assert.deepEqual(await (await service.fetch(`/api/attempts/${expected.attempt.id}`)).json(), expected.attempt);
    assert.deepEqual(historyEvents(history), events);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
