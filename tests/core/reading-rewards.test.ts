import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { levelProgress, scoreXp, stageClearXp } from "../../src/core/reading-rewards.ts";
import type { ReadingAssessment, ReadingContext, ReadingPrompt } from "../../src/core/reading-rewards.ts";

test("reading rewards match the Python reference across stages, help, rhythm and chords", () => {
  const cases: { prompt: ReadingPrompt; assessment: ReadingAssessment; context: ReadingContext }[] = [];
  const patterns = [
    [true, true, true, true, true, true],
    [true, false, true, true, true, true],
    [false, false, false, false, false, false],
    [],
  ];
  for (const stage of [1, 2, 6, 12, 24]) {
    for (const matched of patterns) {
      for (const rhythm of [null, 25, 50, 90, 100]) {
        for (const helped of [false, true]) {
          for (const grouped of [false, true]) {
            cases.push({
              prompt: { reading: { stage_number: stage, rhythm_required: true, introduce: null } },
              assessment: {
                score: { first_try: matched.filter(Boolean).length, total: matched.length },
                observations: matched.map((value, index) => ({ index, ...(grouped ? { group: Math.floor(index / 2) } : {}), matched: value })),
                rhythm: { accuracy: rhythm },
              },
              context: { hearings: Number(helped), reveals: 0, hints: 0 },
            });
          }
        }
      }
    }
  }
  cases.push({
    prompt: { reading: { introduce: 60 } },
    assessment: { score: { first_try: 1, total: 1 }, observations: [] },
    context: { hearings: 0, reveals: 0, hints: 1 },
  });
  const levels = [0, 1, 399, 400, 899, 900, 1499, 1500, 100000];
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.reading_rewards import score_xp, stage_clear_xp, level_progress
data = json.load(sys.stdin)
print(json.dumps({"scores": [score_xp(**case) for case in data["cases"]],
                  "levels": [level_progress(xp) for xp in data["levels"]],
                  "stages": [stage_clear_xp(stage) for stage in range(1, 25)]}))
`], { input: JSON.stringify({ cases, levels }), encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  assert.deepEqual(cases.map(({ prompt, assessment, context }) => scoreXp(prompt, assessment, context)), expected.scores);
  assert.deepEqual(levels.map(levelProgress), expected.levels);
  assert.deepEqual(Array.from({ length: 24 }, (_, index) => stageClearXp(index + 1)), expected.stages);
});
