import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildDrillTask } from "../../src/core/drill-task.ts";
import type { DrillSelection, DrillStanding } from "../../src/core/drill-task.ts";

test("rendered drill tasks match the Python reference", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
from piano_duet.drills import DRILLS, build_task, drill_events, ladder, render, validate
cases = []
index = 0
for drill, spec in DRILLS.items():
    rungs = ladder(drill)
    for variant in spec['variants']:
        for tonic in (0, 1, 6, 11):
            for hands in spec['hands']:
                for octaves in spec['octaves']:
                    if hands == 'contrary' and (octaves > 2 or variant == 'melodic minor'):
                        continue
                    for inversion in range(max(1, len(spec.get('inversions', ())))):
                        for practice in spec['practices']:
                            index += 1
                            if index % 6:
                                continue
                            config = dict(drill=drill, variant=variant, tonic=tonic, hands=hands,
                                          octaves=octaves, inversion=inversion, practice=practice)
                            validate(config)
                            rung = (0, len(rungs) // 2, len(rungs) - 1)[(index // 6) % 3]
                            per_beat, bpm = rungs[rung]
                            if practice in ('long-short', 'short-long') and per_beat > 2:
                                per_beat = 2
                            target = render(drill_events(config), bpm, per_beat, practice)
                            if not any(all(21 <= note['pitch'] + shift <= 108 for note in target) for shift in (0, -12, 12)):
                                continue
                            progress = None if index % 12 else {'working': len(rungs) // 3, 'best': 3, 'streak': 2}
                            task = build_task(config, rung, progress)
                            task['id'] = 'synthetic-task'
                            cases.append([config, rung, progress, task])
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 100_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: [DrillSelection, number, DrillStanding | null, unknown][] = JSON.parse(reference.stdout);
  assert.ok(cases.length >= 400);
  assert.equal(new Set(cases.map(([config]) => config.drill)).size, 9);
  assert.deepEqual(new Set(cases.map(([config]) => config.practice)), new Set(["even", "long-short", "short-long", "accent-3", "accent-4"]));
  for (const [config, rung, progress, expected] of cases) {
    assert.deepEqual(buildDrillTask(config, rung, progress, "synthetic-task"), expected, JSON.stringify(config));
  }
});
