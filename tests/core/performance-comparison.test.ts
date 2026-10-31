import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { comparePerformance } from "../../src/core/performance-comparison.ts";
import { drillTiming, matchDrillNotes } from "../../src/core/drill-timing.ts";
import type { DrillNote } from "../../src/core/drill-timing.ts";
import { assessDrill } from "../../src/core/drill-assessment.ts";
import type { DrillPrompt } from "../../src/core/drill-assessment.ts";
import { drillMilestone, drillProgress } from "../../src/core/drill-progress.ts";
import type { DrillAttempt } from "../../src/core/drill-progress.ts";
import { DRILL_CATALOG, DRILL_MILESTONES } from "../../src/core/drill-catalog.ts";
import { drillLevels } from "../../src/core/drill-levels.ts";
import type { DrillId } from "../../src/core/drill-levels.ts";
import { LocalService } from "../../src/core/local-service.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";
import { coachDrill } from "../../src/core/drill-coach.ts";

test("drill take analysis and progress match Python for controlled synthetic performances", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "tests/core/drill_fixtures.py"], { encoding: "utf8", timeout: 300_000, maxBuffer: 20_000_000 });
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
  const attempts: DrillAttempt[] = fixtures.flatMap((fixture, index) => Array.from({ length: fixture.scenario === "clean" ? 3 : 1 }, (_, repeat) => ({
    mode: "drills", excluded: index % 17 === 0, context: fixture.context, notes: fixture.notes, prompt: fixture.task,
    recognition: fixture.quality, created_at: 1700000000 + Math.floor(index / 54) * 172800 + index * 10 + repeat,
  })));
  const replay = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.drills import DRILLS, coach_config, drill_levels, drill_progress, ladder, milestone
attempts = json.load(sys.stdin)
progress, practice_days = drill_progress(attempts)
levels = drill_levels(progress)
requests = [([], None), (['five_finger'], None), (list(DRILLS), None)] + [([], drill) for drill in DRILLS]
print(json.dumps({"progress": progress, "practice_days": practice_days, "levels": drill_levels(progress),
                  "milestones": {drill: [milestone(drill, rung) for rung in range(len(ladder(drill)))] for drill in DRILLS},
                  "data": {drill: spec['milestones'] for drill, spec in DRILLS.items()},
                  "coaches": [coach_config(progress, levels, avoid, now=1800000000, focus=focus) for avoid, focus in requests],
                  "empty_coach": coach_config({}, drill_levels({}), now=1800000000)}))
`], { encoding: "utf8", timeout: 300_000, input: JSON.stringify(attempts), maxBuffer: 20_000_000 });
  assert.equal(replay.status, 0, replay.stderr);
  const expected = JSON.parse(replay.stdout);
  const actual = drillProgress(attempts);
  assert.deepEqual(actual, { progress: expected.progress, practice_days: expected.practice_days });
  assert.equal(actual.practice_days, 4);
  const take = attempts.find((attempt) => !attempt.excluded && attempt.notes.length)!;
  const extraDay = 1700000000 + 40 * 86400;
  assert.equal(drillProgress([...attempts,
    { ...take, created_at: extraDay, excluded: true },
    { ...take, created_at: extraDay, context: { source: "demo" } },
    { ...take, created_at: extraDay, notes: [] },
    { ...take, created_at: extraDay, mode: "reading" },
  ]).practice_days, 4);
  assert.deepEqual(drillLevels(actual.progress), expected.levels);
  const drills = Object.keys(DRILL_CATALOG.drills) as DrillId[];
  const requests: [DrillId[], DrillId | null][] = [[[], null], [["five_finger"], null], [drills, null], ...drills.map((drill): [DrillId[], DrillId | null] => [[], drill])];
  assert.deepEqual(requests.map(([avoid, focus]) => { const result = coachDrill(actual.progress, avoid, 1800000000, focus); return [result.config, result.reason]; }), expected.coaches);
  const emptyCoach = coachDrill({}, [], 1800000000);
  assert.deepEqual([emptyCoach.config, emptyCoach.reason], expected.empty_coach);
  const events: ReadingLogEvent[] = attempts.flatMap((attempt, index) => {
    const id = `synthetic-${index}`, createdAt = new Date(attempt.created_at * 1000).toISOString();
    const assessment = assessDrill(attempt.prompt, attempt.notes, attempt.context, attempt.recognition);
    const event = { id, deviceId: "test-device", clock: index * 2 + 1, createdAt, kind: "attempt",
      payload: { mode: attempt.mode, prompt: attempt.prompt, context: attempt.context, notes: attempt.notes, assessment, recognition: attempt.recognition } };
    return attempt.excluded ? [event, { id: `exclude-${index}`, deviceId: "test-device", clock: index * 2 + 2, createdAt,
      kind: "exclusion", payload: { attemptId: id, excluded: true } }] : [event];
  });
  const service = new LocalService({ async list() { return events; } });
  assert.deepEqual(await (await service.fetch("/api/drills")).json(),
    { catalog: DRILL_CATALOG, progress: expected.progress, levels: expected.levels, practice_days: expected.practice_days });
  assert.deepEqual(DRILL_MILESTONES, expected.data);
  for (const drill of Object.keys(DRILL_CATALOG.drills) as DrillId[]) {
    assert.deepEqual(DRILL_CATALOG.drills[drill].ladder.map((_, rung) => drillMilestone(drill, rung)), expected.milestones[drill]);
  }
});
