import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readingProgress } from "../../src/core/reading-progress.ts";
import type { ProgressAttempt } from "../../src/core/reading-progress.ts";

test("reading progress rebuild matches Python from attempts and assisted practice", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.reading import assess_reading
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import reading_attacks
from piano_duet.reading_stages import STAGES
from reading_recording import record_composition
attempts = []
for stage in (STAGES[0], STAGES[1], STAGES[6], STAGES[11]):
    for seed in range(8):
        task = record_composition(stage, seed)["score"]
        task.update(family="reading", id=f"{stage['id']}-{seed}")
        groups = [[{"pitch": task["target"][i]["pitch"], "start": 1 + attack["start"] + (0.1 if seed == 3 and n >= 4 else 0), "velocity": 80, "confidence": 0.95} for i in attack["indices"]] for n, attack in enumerate(reading_attacks(task["target"]))]
        context = {"source": "microphone", "interaction": "step_by_step", "hearings": 0, "reveals": 0, "hints": 1 if seed == 4 else 0, "reading_timing": {"interruptions": []}}
        assessment, notes = assess_reading(task, groups, context)
        attempts.append({"id": len(attempts), "created_at": f"2026-01-{seed + 1:02}", "excluded": seed == 5, "prompt": task, "context": context, "assessment": assessment})
intro = dict(attempts[0])
intro["id"] = 100
intro["context"] = dict(intro["context"], introduction=True)
intro["prompt"] = dict(intro["prompt"], reading=dict(intro["prompt"]["reading"], introduce=60))
intro["assessment"] = dict(intro["assessment"], evidence=[])
attempts.append(intro)
histories = [attempts[:size] for size in (0, 1, 4, 8, 16, len(attempts))]
print(json.dumps({"histories": histories, "expected": [reading_progress(history) for history in histories]}))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 50_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { histories: ProgressAttempt[][]; expected: unknown[] } = JSON.parse(reference.stdout);
  assert.deepEqual(data.histories.map(readingProgress), data.expected);
});
