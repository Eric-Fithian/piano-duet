import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { analyzeVariation } from "../../src/core/variation-analysis.ts";
import type { ContextNote } from "../../src/core/aria-tokenizer.ts";
import type { VariationDetail } from "../../src/core/variation-analysis.ts";

test("Variations teacher forcing and chord-safe pitch analysis match Python", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
from threading import Event
from types import SimpleNamespace
import mlx.core as mx
from ariautils.tokenizer import AbsTokenizer
from piano_duet.learning import analyze_phrase
from piano_duet.notes import Note
class Model:
    def __init__(self): self.calls = []
    def setup_cache(self, *args, **kwargs): pass
    def __call__(self, tokens, positions, **kwargs):
        self.calls.append({'tokens': tokens[0].tolist(), 'reset': int(positions[0].item()) == 0})
        favourite = (60, 64, 67, 62, 72)[(len(self.calls)-1) % 5]
        ids = mx.arange(17727)
        logits = ((ids % 23).astype(mx.float32) - 11) * .1
        logits = logits + mx.where((ids >= 39 + favourite * 13 + 1) & (ids <= 39 + favourite * 13 + 12), 4., 0.)
        return mx.broadcast_to(logits[None, None, :], (1, tokens.shape[1], 17727))
tokenizer = AbsTokenizer()
ids = [i for i,tok in tokenizer.id_to_tok.items() if isinstance(tok,tuple) and tok[0] == 'piano' and 21 <= tok[1] <= 108 and tok[2] > 0]
notes = [Note(pitch=(60,64,67)[i%3] + (12 if (i//3)%4 == 0 else 0), start=.2+(i//3)*.25+(i%3)*.02, duration=.3, velocity=80) for i in range(90)]
model = Model()
result, progress = analyze_phrase(SimpleNamespace(tokenizer=tokenizer, model=model, note_ids=ids), notes, .96, Event(), lambda detail, value: None)
print(json.dumps({'input': [n.model_dump() for n in notes], 'notes': [n.model_dump() for n in result], 'analysis': progress, 'calls': model.calls}))
`], { encoding: "utf8", maxBuffer: 5_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected: { input: ContextNote[]; notes: ContextNote[]; analysis: VariationDetail[]; calls: { tokens: number[]; reset: boolean }[] } = JSON.parse(reference.stdout);
  const calls: { tokens: number[]; reset: boolean }[] = [];
  const session = { async run(input: { tokens: number[]; reset: boolean }) {
    calls.push(input);
    const favourite = [60, 64, 67, 62, 72][(calls.length - 1) % 5];
    const logits = Float32Array.from({ length: 17727 }, (_, token) => Math.fround(Math.fround((token % 23 - 11) * Math.fround(0.1))
      + (token >= 39 + favourite * 13 + 1 && token <= 39 + favourite * 13 + 12 ? 4 : 0)));
    return { logits };
  } };
  const progress: number[] = [];
  const result = await analyzeVariation(session, expected.input, 0.96, undefined, (_detail, value) => progress.push(value));
  assert.deepEqual(calls, expected.calls);
  assert.deepEqual(result.notes, expected.notes);
  assert.equal(result.analysis.length, expected.analysis.length);
  for (let index = 0; index < result.analysis.length; index++) {
    const actual = result.analysis[index], referenceDetail = expected.analysis[index];
    for (const field of ["probability", "expected_probability", "surprise"] as const) assert.ok(Math.abs(actual[field] - referenceDetail[field]) < 1e-6);
    assert.deepEqual({ ...actual, probability: 0, expected_probability: 0, surprise: 0 },
      { ...referenceDetail, probability: 0, expected_probability: 0, surprise: 0 });
  }
  assert.equal(progress.at(-1), 1);
  assert.ok(result.analysis.some((note) => note.changed));
  assert.ok(result.analysis.some((note) => note.chord_collision));
});

test("stopping Variations cancels an in-flight model call", async () => {
  const abort = new AbortController();
  const session = { async run(_input: unknown, signal?: AbortSignal): Promise<{ logits: Float32Array }> {
    assert.equal(signal, abort.signal);
    return new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      abort.abort();
    });
  } };
  await assert.rejects(analyzeVariation(session, [{ pitch: 60, start: 0, duration: 0.5, velocity: 80 }], 0.95, abort.signal), { name: "AbortError" });
});
