import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { comparePerformance } from "../../src/core/performance-comparison.ts";
import type { PerformanceNote } from "../../src/core/performance-comparison.ts";

test("drill take alignment matches Python for controlled synthetic performances", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "tests/core/drill_fixtures.py"], { encoding: "utf8", maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const fixtures: { drill: string; scenario: string; task: { target: PerformanceNote[] }; notes: PerformanceNote[]; comparison: unknown }[] = JSON.parse(reference.stdout);
  assert.equal(fixtures.length, 54);
  for (const fixture of fixtures) {
    const seen = new Set<string>();
    const target = fixture.task.target.filter((note) => {
      const key = JSON.stringify([note.pitch, note.start]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    assert.deepEqual(comparePerformance(target, fixture.notes), fixture.comparison, `${fixture.drill}: ${fixture.scenario}`);
  }
});
