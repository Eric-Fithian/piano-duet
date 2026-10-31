import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DRILL_CATALOG } from "../../src/core/drill-catalog.ts";
import { drillLevels } from "../../src/core/drill-levels.ts";
import type { DrillLevelEntry } from "../../src/core/drill-levels.ts";

test("drill catalog and levels match Python across synthetic histories", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, random
from piano_duet.drills import DRILLS, catalog, drill_levels, ladder
rng = random.Random(142)
histories = [{}]
for size in (5, 40, 200, 800):
    history = {}
    for index in range(size):
        drill = rng.choice(list(DRILLS))
        spec = DRILLS[drill]
        history[str(index)] = {
            "config": {"drill": drill, "variant": rng.choice(spec["variants"]), "tonic": rng.randrange(12), "hands": rng.choice(spec["hands"])},
            "best": rng.choice([None, rng.randrange(len(ladder(drill)))]),
            "last": rng.randrange(1700000000, 1800000000),
        }
    histories.append(history)
print(json.dumps({"catalog": catalog(), "histories": histories, "levels": [drill_levels(history) for history in histories]}))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { catalog: unknown; histories: Record<string, DrillLevelEntry>[]; levels: unknown[] } = JSON.parse(reference.stdout);
  assert.deepEqual(DRILL_CATALOG, data.catalog);
  assert.deepEqual(data.histories.map(drillLevels), data.levels);
});
