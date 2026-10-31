import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { drillPattern } from "../../src/core/drill-patterns.ts";
import type { DrillConfig } from "../../src/core/drill-assessment.ts";

test("drill note and fingering patterns match Python across configurations", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
from piano_duet.drills import DRILLS, drill_events, validate
cases = []
for drill, spec in DRILLS.items():
    for variant in spec['variants']:
        for tonic in (0, 1, 6, 11):
            for hands in spec['hands']:
                for octaves in spec['octaves']:
                    if hands == 'contrary' and (octaves > 2 or variant == 'melodic minor'):
                        continue
                    for inversion in range(max(1, len(spec.get('inversions', ())))):
                        config = dict(drill=drill, variant=variant, tonic=tonic, hands=hands,
                                      octaves=octaves, inversion=inversion, practice='even')
                        validate(config)
                        cases.append([config, drill_events(config)])
print(json.dumps(cases))
`], { encoding: "utf8", maxBuffer: 100_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: [DrillConfig, unknown][] = JSON.parse(reference.stdout);
  assert.equal(cases.length, 912);
  for (const [config, expected] of cases) assert.deepEqual(drillPattern(config), expected, JSON.stringify(config));
});
