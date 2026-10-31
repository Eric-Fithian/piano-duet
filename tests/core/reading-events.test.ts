import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readingProgressFromEvents } from "../../src/core/reading-events.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";
import type { ComposerProgress } from "../../src/core/reading-composer.ts";

test("reading event replay merges exclusions and rebuilds the Python progress", () => {
  const initial: ComposerProgress = readingProgressFromEvents([]);
  assert.equal(initial.curriculum.target, "first_notes");
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.reading import assess_reading
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import reading_attacks
from piano_duet.reading_stages import STAGES
from reading_recording import record_composition
attempts, events = [], []
created = "2026-01-01T00:00:00.000Z"
for seed in range(8):
    task = record_composition(STAGES[0], seed)["score"]
    task.update(family="reading", id=f"score-{seed}")
    groups = [[{"pitch": task["target"][i]["pitch"], "start": 1 + attack["start"], "velocity": 80, "confidence": 0.95} for i in attack["indices"]] for attack in reading_attacks(task["target"])]
    context = {"source": "microphone", "interaction": "step_by_step", "hearings": 0, "reveals": 0, "hints": 0, "reading_timing": {"interruptions": []}}
    assessment, notes = assess_reading(task, groups, context)
    payload = {"prompt": task, "context": context, "assessment": assessment, "mode": "practice", "notes": notes}
    id_ = f"attempt-{seed}"
    attempts.append(dict(payload, id=id_, created_at=1767225600.0, excluded=seed == 1))
    events.append({"id": id_, "deviceId": "a", "clock": seed + 1, "createdAt": created, "kind": "attempt", "payload": payload})
events += [
    {"id": "exclude", "deviceId": "a", "clock": 10, "createdAt": created, "kind": "exclusion", "payload": {"attemptId": "attempt-1", "excluded": True}},
    {"id": "exclude-other", "deviceId": "a", "clock": 11, "createdAt": created, "kind": "exclusion", "payload": {"attemptId": "attempt-2", "excluded": True}},
    {"id": "restore-other", "deviceId": "b", "clock": 11, "createdAt": created, "kind": "exclusion", "payload": {"attemptId": "attempt-2", "excluded": False}},
    {"id": "pending", "deviceId": "b", "clock": 12, "createdAt": created, "kind": "exclusion", "payload": {"attemptId": "not-yet-synced", "excluded": True}},
    {"id": "song", "deviceId": "a", "clock": 13, "createdAt": created, "kind": "song", "payload": {"title": "Study"}},
]
print(json.dumps({"events": events, "expected": reading_progress(attempts)}))
`], { encoding: "utf8", maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { events: ReadingLogEvent[]; expected: unknown } = JSON.parse(reference.stdout);
  assert.deepEqual(readingProgressFromEvents([...data.events].reverse()), data.expected);
  assert.throws(() => readingProgressFromEvents([data.events[0], data.events[0]]), { message: "Duplicate practice event attempt-0" });
  assert.throws(() => readingProgressFromEvents([{ ...data.events[0], kind: "exclusion", payload: { attemptId: "x" } }]), { message: "Invalid exclusion event" });
});
