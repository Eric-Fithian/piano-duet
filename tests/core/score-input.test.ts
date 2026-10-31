import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scoreInput } from "../../src/core/score-input.ts";
import type { ScoreInputNote, ScoreInputTokens } from "../../src/core/score-input.ts";

test("score input buckets match the Python MIDI tokenizer", () => {
  const fixture: { notes: ScoreInputNote[]; expected: ScoreInputTokens } = JSON.parse(readFileSync("tests/fixtures/score-input.json", "utf8"));
  assert.deepEqual(scoreInput(fixture.notes), fixture.expected);
  assert.throws(() => scoreInput([]));
  assert.throws(() => scoreInput([{ pitch: 60, velocity: 80, start: 0, duration: 0.0001 }]));
});
