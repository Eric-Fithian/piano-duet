import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { learnerProfile } from "../../src/core/learner-profile.ts";
import type { ProfileAttempt } from "../../src/core/learner-profile.ts";
import { attemptsFromEvents } from "../../src/core/reading-events.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";

test("learner profiles match Python for reading and other practice evidence", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.profile import build_profile
from piano_duet.reading import assess_reading
from piano_duet.reading_music import reading_attacks
from piano_duet.reading_stages import STAGES
from reading_recording import record_composition
attempts = []
for seed in range(12):
    task = record_composition(STAGES[0], seed)["score"]
    task.update(family="reading", id=f"score-{seed}")
    groups = [[{"pitch": task["target"][i]["pitch"], "start": 1 + attack["start"], "velocity": 80, "confidence": 0.95} for i in attack["indices"]] for attack in reading_attacks(task["target"])]
    context = {"source": "microphone", "interaction": "step_by_step", "hearings": 0, "reveals": 0, "hints": 0, "reading_timing": {"interruptions": []}}
    assessment, notes = assess_reading(task, groups, context)
    attempts.append({"id": f"reading-{seed}", "created_at": 1700000000 + 90000 * seed, "mode": "practice", "excluded": seed == 3,
        "prompt": task, "context": context, "assessment": assessment, "notes": notes})
for seed in range(8):
    evidence = [{"skill": "technique.accuracy", "facet": "all", "label": "Note accuracy", "value": 1 if seed % 3 else 0.5, "weight": 1, "challenge": 2},
        {"skill": "technique.accuracy", "facet": "key:C", "label": "C major", "value": 1, "weight": 1, "challenge": 2}]
    attempts.append({"id": f"drill-{seed}", "created_at": 1701000000 + 90000 * seed, "mode": "practice", "excluded": seed == 2,
        "prompt": {"family": "technique", "title": "Exercise", "target": []}, "context": {"source": "microphone"}, "assessment": {"evidence": evidence}, "notes": [{"pitch": 60}]})
attempts.append({"id": "demo", "created_at": 1702000000, "mode": "duet", "excluded": False,
    "prompt": {"family": "creating", "title": "Idea", "target": []}, "context": {"source": "microphone"}, "assessment": {"evidence": []}, "notes": [{"pitch": 60}]})
histories = [attempts[:size] for size in (0, 1, 6, 12, 18, len(attempts))]
print(json.dumps({"histories": histories, "expected": [build_profile(history, now=1703000000) for history in histories]}))
`], { encoding: "utf8", maxBuffer: 50_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { histories: ProfileAttempt[][]; expected: unknown[] } = JSON.parse(reference.stdout);
  assert.deepEqual(data.histories.map((attempts) => learnerProfile(attempts, 1703000000)), data.expected);
  for (const [index, history] of data.histories.entries()) {
    const events: ReadingLogEvent[] = [];
    for (const attempt of history) {
      const { id, created_at, excluded, ...payload } = attempt;
      events.push({ id, deviceId: "device", clock: events.length + 1, createdAt: new Date(created_at * 1000).toISOString(), kind: "attempt", payload });
      if (excluded) events.push({ id: `exclude-${id}`, deviceId: "device", clock: events.length + 1,
        createdAt: new Date(created_at * 1000).toISOString(), kind: "exclusion", payload: { attemptId: id, excluded: true } });
      else {
        events.push({ id: `exclude-${id}`, deviceId: "device", clock: events.length + 1,
          createdAt: new Date(created_at * 1000).toISOString(), kind: "exclusion", payload: { attemptId: id, excluded: true } });
        events.push({ id: `restore-${id}`, deviceId: "device", clock: events.length + 1,
          createdAt: new Date(created_at * 1000).toISOString(), kind: "exclusion", payload: { attemptId: id, excluded: false } });
      }
    }
    assert.deepEqual(learnerProfile(attemptsFromEvents(events.reverse()), 1703000000), data.expected[index]);
  }
});
