import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assessReading, matchesReading } from "../../src/core/reading-assessment.ts";
import type { HeardNote, ReadingAssessmentContext } from "../../src/core/reading-assessment.ts";
import type { ReadingScore } from "../../src/core/reading-composer.ts";

test("reading assessments match Python across stages, mistakes and assistance", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.reading import assess_reading
from piano_duet.reading_music import reading_attacks
from piano_duet.reading_stages import STAGES
from reading_recording import record_composition
cases = []
for stage in STAGES:
    task = record_composition(stage, 7)["score"]
    for scenario in ("correct", "mistake", "assisted", "uncertain", "interrupted", "familiar"):
        groups = []
        for index, attack in enumerate(reading_attacks(task["target"])):
            if scenario == "mistake" and index == 3:
                expected = [task["target"][i]["pitch"] for i in attack["indices"]]
                wrong = next(p for p in (21, 22, 23, 24) if all((p - q) % 12 for q in expected))
                groups.append([{"pitch": wrong, "start": 1 + attack["start"] - 0.02, "velocity": 80, "confidence": 0.95}])
            groups.append([{"pitch": task["target"][i]["pitch"], "start": 1 + attack["start"], "velocity": 80, "confidence": 0.5 if scenario == "uncertain" else 0.95} for i in attack["indices"]])
        context = {"hearings": 1 if scenario == "assisted" else 0, "reveals": 0, "hints": 0,
            "reading_timing": {"interruptions": [4] if scenario == "interrupted" else []}, "familiar": scenario == "familiar"}
        assessment, notes = assess_reading(task, groups, context)
        cases.append({"task": task, "groups": groups, "context": context, "expected": {"assessment": assessment, "notes": notes}})
print(json.dumps(cases))
`], { encoding: "utf8", maxBuffer: 50_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { task: ReadingScore; groups: HeardNote[][]; context: ReadingAssessmentContext; expected: unknown }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    const actual = assessReading(item.task, item.groups, item.context);
    assert.deepEqual(actual, item.expected, item.task.title);
    if (item.context.familiar) assert.deepEqual(actual.assessment.evidence, []);
  }
  assert.ok(matchesReading([60, 72], [60]));
  assert.equal(matchesReading([72], [60]), false);
  assert.equal(matchesReading([60, 61], [60]), false);
});
