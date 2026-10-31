import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { historyEvents } from "../../src/core/history-import.ts";
import type { LegacyHistory } from "../../src/core/history-import.ts";
import { LocalService } from "../../src/core/local-service.ts";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Supply a read-only history database path");
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sqlite3, sys
from pathlib import Path
from piano_duet.profile import build_profile
from piano_duet.drills import drill_progress, drill_levels
path = Path(sys.argv[1]).resolve().as_uri() + '?mode=ro&immutable=1'
with sqlite3.connect(path, uri=True) as db:
    rows = db.execute('SELECT id, created_at, inputs, assessment, excluded FROM attempts ORDER BY created_at, rowid').fetchall()
    attempts = [{'id': ident, 'created_at': at, **json.loads(inputs), 'assessment': json.loads(assessment), 'excluded': bool(excluded)} for ident, at, inputs, assessment, excluded in rows]
    counts = {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in ('attempts', 'tasks', 'pieces', 'songs', 'song_plays')}
profile = build_profile(attempts)
progress, practice_days = drill_progress(attempts)
print(json.dumps({'counts': counts, 'profile': profile, 'drills': {'progress': progress, 'levels': drill_levels(progress), 'practice_days': practice_days}}))
`, path], { encoding: "utf8", maxBuffer: 100_000_000 });
  if (reference.status !== 0) throw new Error(`Python reference failed: ${reference.stderr}`);
  const expected = JSON.parse(reference.stdout);
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = (table: string, order: string) => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  const history = { attempts: rows("attempts", "created_at, rowid"), tasks: rows("tasks", "created_at, rowid"),
    pieces: rows("pieces", "rowid"), songs: rows("songs", "created_at, rowid"), song_plays: rows("song_plays", "created_at, rowid") } as LegacyHistory;
  db.close();
  const events = historyEvents(history), service = new LocalService({ async list() { return events; } }, undefined, () => expected.profile.generated_at);
  const profile = await (await service.fetch("/api/profile")).json(), drills = await (await service.fetch("/api/drills")).json();
  const library = await (await service.fetch("/api/library")).json(), pieces = await (await service.fetch("/api/pieces")).json();
  const counts = Object.fromEntries(Object.entries(history).map(([key, value]) => [key, value.length]));
  const checks: Record<string, boolean> = {
    counts: JSON.stringify(counts) === JSON.stringify(expected.counts),
    songs: library.songs.length === expected.counts.songs,
    pieces: pieces.length === expected.counts.pieces,
    stage: JSON.stringify(profile.reading.curriculum) === JSON.stringify(expected.profile.reading.curriculum),
    xp: JSON.stringify(profile.reading.xp) === JSON.stringify(expected.profile.reading.xp),
    levels: JSON.stringify(profile.skills) === JSON.stringify(expected.profile.skills),
    drill_levels: JSON.stringify(drills.levels) === JSON.stringify(expected.drills.levels),
    drill_progress: JSON.stringify(drills.progress) === JSON.stringify(expected.drills.progress),
    practice_days: drills.practice_days === expected.drills.practice_days,
    profile_totals: ["attempts", "included_attempts", "notes", "days", "creative_phrases"].every((key) => profile[key] === expected.profile[key]),
  };
  console.log(JSON.stringify({ counts, checks }));
  if (Object.values(checks).some((value) => !value)) throw new Error("History aggregate parity failed");
}

await main();
