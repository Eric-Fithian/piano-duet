import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { composeReading } from "../../src/core/reading-composer.ts";
import type { ComposerProgress, ComposerStage, ReadingScore } from "../../src/core/reading-composer.ts";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

test("whole reading scores replay Python's random and phrase choices in every stage", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "tests/reading_recording.py"], { encoding: "utf8", timeout: 300_000, maxBuffer: 50_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { stage: ComposerStage; progress: ComposerProgress; context: unknown; events: ReplayEvent[]; score: ReadingScore }[] = JSON.parse(reference.stdout);
  assert.equal(cases.length, 48);
  for (const item of cases) {
    const replay = new ReadingReplay(item.events);
    const score = await composeReading(item.stage, item.progress, replay, (context) => {
      replay.phrase(context as never);
      return { note: (onset, pitches, durations) => replay.note(onset, [...pitches], [...durations]),
        chordChance: (pitches) => replay.chordChance(pitches) };
    }, item.context);
    assert.deepEqual(score, item.score, item.stage.id);
    replay.finish();
  }
});
