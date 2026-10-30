import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { curriculumProgress } from "../../src/core/reading-curriculum.ts";
import type { CurriculumAttempt } from "../../src/core/reading-curriculum.ts";

test("reading curriculum rebuild matches Python across attempts, exclusions and replay", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.reading import assess_reading
from piano_duet.reading_music import reading_attacks
from piano_duet.reading_stages import STAGES, curriculum_progress
from reading_recording import record_composition
attempts = []
for stage in (STAGES[0], STAGES[1], STAGES[6], STAGES[11], STAGES[23]):
    for seed in range(6):
        task = record_composition(stage, seed)["score"]
        task.update(family="reading", id=f"{stage['id']}-{seed}")
        groups = [[{"pitch": task["target"][i]["pitch"], "start": 1 + attack["start"], "velocity": 80, "confidence": 0.95} for i in attack["indices"]] for attack in reading_attacks(task["target"])]
        context = {"source": "microphone", "hearings": 0, "reveals": 0, "hints": 1 if seed == 4 else 0, "reading_timing": {"interruptions": []}}
        assessment, notes = assess_reading(task, groups, context)
        attempts.append({"excluded": seed == 5, "prompt": task, "context": context, "assessment": assessment})
attempts.insert(3, attempts[0])
histories = [attempts[:size] for size in (0, 1, 3, 7, 14, len(attempts))]
print(json.dumps({"histories": histories, "expected": [curriculum_progress(history) for history in histories], "replay": curriculum_progress(attempts, 1)}))
`], { encoding: "utf8", maxBuffer: 50_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { histories: CurriculumAttempt[][]; expected: unknown[]; replay: unknown } = JSON.parse(reference.stdout);
  assert.deepEqual(data.histories.map((attempts) => curriculumProgress(attempts)), data.expected);
  assert.deepEqual(curriculumProgress(data.histories.at(-1)!, 1), data.replay);
  assert.throws(() => curriculumProgress([], 24), /locked/);
  assert.throws(() => curriculumProgress([], 25), /1 to 24/);
});
