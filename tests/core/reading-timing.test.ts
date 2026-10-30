import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readingTiming } from "../../src/core/reading-timing.ts";
import type { TimedObservation, TimingContext, TimingTask } from "../../src/core/reading-timing.ts";

test("reading timing matches Python with pauses, corrections and interruptions", () => {
  const cases: { task: TimingTask; observations: TimedObservation[]; context: TimingContext }[] = [];
  for (const stage of [null, "first_notes", "dotted", "expert"]) for (const scenario of ["steady", "hesitant", "incorrect", "uncertain", "interrupted", "missing"]) {
    const observations = Array.from({ length: 12 }, (_, index) => ({ index, start: index * 0.5,
      heard_at: 1 + index * 0.5 + (scenario === "hesitant" && index >= 5 ? 0.4 : 0), group: index,
      confidence: scenario === "uncertain" && index === 4 ? 0.6 : 0.95, matched: scenario !== "incorrect" || index !== 7 }));
    cases.push({ task: { bpm: 60, reading: { stage_id: stage, positions: [{ index: 0 }, { index: 6 }] } }, observations,
      context: { reading_timing: scenario === "missing" ? null : { interruptions: scenario === "interrupted" ? [3, 8] : [] } } });
  }
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.reading_stages import reading_rhythm
cases = json.loads(sys.stdin.readline())
print(json.dumps([reading_rhythm(c["task"], c["observations"], c["context"]) for c in cases]))
`], { input: JSON.stringify(cases) + "\n", encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  assert.deepEqual(cases.map(({ task, observations, context }) => readingTiming(task, observations, context)), JSON.parse(reference.stdout));
});
