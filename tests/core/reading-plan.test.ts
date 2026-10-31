import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { planScore } from "../../src/core/reading-plan.ts";
import type { PlanStage } from "../../src/core/reading-plan.ts";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

test("score plans replay the Python choices across every stage and meter", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.reading_stages import STAGES
from piano_duet.reading_music import plan_score
from reading_recording import RecordingRandom
cases = []
for stage in STAGES:
    for meter in stage["meters"]:
        active = ["treble"] if stage["texture"] in ("single", "dyads") else ["bass", "treble"]
        events = []
        shifts, figured, altered = plan_score(stage, active, meter, RecordingRandom(23, events))
        cases.append({"stage": stage, "active": active, "meter": meter, "events": events, "shifts": {key: sorted(value) for key, value in shifts.items()}, "figured": sorted(figured), "altered": sorted(altered)})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { stage: PlanStage; active: string[]; meter: string; events: ReplayEvent[]; shifts: Record<string, number[]>; figured: number[]; altered: number[] }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    const replay = new ReadingReplay(item.events);
    const plan = planScore(item.stage, item.active, item.meter, replay);
    const sorted = (values: Set<number>) => [...values].sort((a, b) => a - b);
    assert.deepEqual(Object.fromEntries(Object.entries(plan.shifts).map(([staff, bars]) => [staff, sorted(bars)])), item.shifts);
    assert.deepEqual(sorted(plan.figured), item.figured);
    assert.deepEqual(sorted(plan.altered), item.altered);
    replay.finish();
  }
});
