import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { constrainedDistribution, durationMask, pitchMask } from "../../src/core/constrained-sampling.ts";
import type { PhraseVocabulary } from "../../src/core/constrained-sampling.ts";

test("pitch and duration masks and sampling biases match ConstrainedPhrase", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, math, random
from types import SimpleNamespace
import mlx.core as mx
from ariautils.tokenizer import AbsTokenizer
from piano_duet.generation import ConstrainedPhrase
class Model:
    def setup_cache(self, *args, **kwargs): pass
class Capture(ConstrainedPhrase):
    def choose(self, options):
        self.masks.append(list(options.items()))
        return next(iter(options))
tokenizer = AbsTokenizer()
ids = [i for i, token in tokenizer.id_to_tok.items() if isinstance(token, tuple) and token[0] == "piano" and 21 <= token[1] <= 108 and token[2] > 0]
generator = SimpleNamespace(tokenizer=tokenizer, note_ids=ids, model=Model())
cases = []
for pitches, durations in [([(60, 1.0), (64, 2.3)], [(0.2, 1.0), (0.4, 3.0)]), ([(21, 0.2), (108, 4.5), (72, 1.1)], [(0.1, 2.0), (1.25, 0.5)]), ([(60, 1.0)], [(0.5, 1.0)])]:
    phrase = Capture(generator, random.Random(0))
    phrase.masks = []
    phrase.note(0, dict(pitches), dict(durations))
    cases.append({"pitches": pitches, "durations": durations, "masks": phrase.masks})
phrase = Capture(generator, random.Random(0))
pitch_tokens = list(phrase.pitch_tokens.items())
duration_tokens = [(token[1], tokenizer.tok_to_id[token]) for token in tokenizer.dur_tokens]
logits = [1.3, -2.4, 0.2, 3.5, -0.6, 2.0]
weights = [(0, 2.0), (1, 7.0), (2, 0.2), (3, 0.4), (4, 3.0), (5, 1.0)]
scores = mx.array([logits[i] for i, _ in weights], dtype=mx.float32) / 0.95 + mx.log(mx.array([w for _, w in weights], dtype=mx.float32))
scores = mx.where(scores >= mx.max(scores) + math.log(0.035), scores, -float("inf"))
print(json.dumps({"pitchTokens": pitch_tokens, "durationTokens": duration_tokens, "maxDurationMs": tokenizer.max_dur_ms, "cases": cases, "logits": logits, "weights": weights, "probabilities": mx.softmax(scores).tolist()}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { pitchTokens: [number, number[]][]; durationTokens: [number, number][]; maxDurationMs: number;
    cases: { pitches: [number, number][]; durations: [number, number][]; masks: [number, number][][] }[];
    logits: number[]; weights: [number, number][]; probabilities: number[] } = JSON.parse(reference.stdout);
  const vocabulary: PhraseVocabulary = { pitchTokens: new Map(data.pitchTokens), durationTokens: new Map(data.durationTokens), maxDurationMs: data.maxDurationMs };
  for (const item of data.cases) {
    assert.deepEqual([...pitchMask(vocabulary, new Map(item.pitches))], item.masks[0]);
    assert.deepEqual([...durationMask(vocabulary, new Map(item.durations))].map(([token, value]) => [token, value.weight]), item.masks[1]);
  }
  const actual = [...constrainedDistribution(data.logits, new Map(data.weights)).values()];
  actual.forEach((probability, index) => assert.ok(Math.abs(probability - data.probabilities[index]) < 1e-6));
  assert.throws(() => durationMask(vocabulary, new Map([[0.2, 1], [0.201, 1]])), /same Aria token/);
});
