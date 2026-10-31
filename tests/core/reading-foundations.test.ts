import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readingFoundation } from "../../src/core/reading-foundations.ts";
import type { FoundationCandidate } from "../../src/core/reading-foundations.ts";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

test("foundation scores replay Python introductions and melodies", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.reading_curriculum import reading_candidate, reading_progress
from reading_recording import RecordingPhrase, RecordingRandom
cases = []
for stage in (1, 2):
    for seed in range(8):
        for scenario in ("introduction", "melody", "weak"):
            progress = reading_progress([])
            progress["curriculum"].update(target="first_notes" if stage == 1 else "steps_skips", target_number=stage)
            if scenario == "weak":
                progress["hands"]["bass"]["starts"]["accuracy"] = 55
                progress["hands"]["bass"]["patterns"].update(accuracy=88, samples=10, ready=True)
            teach = scenario == "introduction"
            context = None if seed % 2 == 0 else {"notes": [{"pitch": 60, "start": 0, "duration": 0.5, "velocity": 76}], "end": 0.5}
            events = []
            score = reading_candidate(progress, RecordingRandom(seed, events), RecordingPhrase, teach=teach, context=context)
            cases.append({"progress": progress, "events": events, "context": context, "teach": teach, "score": score})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 30_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { progress: Parameters<typeof readingFoundation>[0]; events: ReplayEvent[]; context: unknown; teach: boolean; score: FoundationCandidate }[] = JSON.parse(reference.stdout);
  assert.equal(cases.length, 48);
  for (const item of cases) {
    const replay = new ReadingReplay(item.events);
    const score = await readingFoundation(item.progress, replay, (context) => {
      replay.phrase(context as never);
      return { note: (onset, pitches, durations) => replay.note(onset, [...pitches], [...durations]), chordChance: (pitches) => replay.chordChance(pitches) };
    }, null, 0, false, item.teach, item.context);
    assert.deepEqual(score, item.score);
    replay.finish();
  }
});
