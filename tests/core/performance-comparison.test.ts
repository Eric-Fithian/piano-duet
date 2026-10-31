import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { comparePerformance } from "../../src/core/performance-comparison.ts";
import { drillTiming, matchDrillNotes } from "../../src/core/drill-timing.ts";
import type { DrillNote } from "../../src/core/drill-timing.ts";
import { assessDrill } from "../../src/core/drill-assessment.ts";
import type { DrillPrompt } from "../../src/core/drill-assessment.ts";

test("drill take alignment matches Python for controlled synthetic performances", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "tests/core/drill_fixtures.py"], { encoding: "utf8", maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const fixtures: { drill: string; scenario: string; task: DrillPrompt; notes: DrillNote[]; comparison: ReturnType<typeof comparePerformance>;
    timing: unknown; assessment: unknown; context: { source: string }; quality: { usable: boolean } }[] = JSON.parse(reference.stdout);
  assert.equal(fixtures.length, 216);
  for (const fixture of fixtures) {
    const seen = new Set<string>();
    const target = fixture.task.target.filter((note) => {
      const key = JSON.stringify([note.pitch, note.start]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const comparison = comparePerformance(target, fixture.notes);
    assert.deepEqual(comparison, fixture.comparison, `${fixture.drill}: ${fixture.scenario}`);
    const matched = matchDrillNotes(target, fixture.notes, comparison.alignment);
    assert.deepEqual(drillTiming(target, fixture.notes, matched, comparison.alignment, fixture.task.bpm, fixture.task.key), fixture.timing,
      `${fixture.drill}: ${fixture.scenario} timing`);
    assert.deepEqual(assessDrill(fixture.task, fixture.notes, fixture.context, fixture.quality), fixture.assessment,
      `${fixture.drill}: ${fixture.scenario} assessment`);
  }
});
