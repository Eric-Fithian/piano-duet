import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AriaPhrase } from "../../src/core/aria-phrase.ts";
import type { AriaSession } from "../../src/core/aria-phrase.ts";
import type { PhraseContext } from "../../src/core/aria-tokenizer.ts";

test("Aria phrase notes, model calls, biases and chord probes match Python", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, random, sys
sys.path.insert(0, "tests")
from types import SimpleNamespace
import mlx.core as mx
from ariautils.tokenizer import AbsTokenizer
from piano_duet.generation import ConstrainedPhrase
from reading_recording import RecordingRandom
class Model:
    def __init__(self): self.calls = []
    def setup_cache(self, *args, **kwargs): pass
    def __call__(self, tokens, positions, **kwargs):
        values = tokens.tolist()[0]
        self.calls.append({"tokens": values, "position": int(positions.tolist()[0])})
        logits = ((mx.arange(17727) % 23).astype(mx.float32) - 11) * 0.1
        return mx.broadcast_to(logits[None, None, :], (1, len(values), 17727))
tokenizer = AbsTokenizer()
ids = [i for i, tok in tokenizer.id_to_tok.items() if isinstance(tok, tuple) and tok[0] == "piano" and 21 <= tok[1] <= 108 and tok[2] > 0]
contexts = [None, {"notes": [{"pitch": 60, "start": 0.2, "duration": 0.4, "velocity": 80}], "end": 1.2}]
cases = []
for context in contexts:
    model, events = Model(), []
    phrase = ConstrainedPhrase(SimpleNamespace(tokenizer=tokenizer, model=model, note_ids=ids), RecordingRandom(19, events), context)
    steps = [(0, [(60, 1.0), (64, 2.0)], [(0.2, 1.0), (0.4, 2.0)]), (0.1, [(68, 1.0), (72, 2.0)], [(0.3, 1.0)]), (0.1, [(80, 1.0), (84, 1.5)], [(0.2, 1.0), (0.5, 1.0)]), (5.1, [(48, 1.0), (52, 1.0)], [(0.4, 1.0)])]
    notes, chance = [], None
    for index, (onset, pitches, durations) in enumerate(steps):
        notes.append(phrase.note(onset, dict(pitches), dict(durations)))
        if index == 0: chance = phrase.chord_chance([67, 69])
    cases.append({"context": context, "steps": steps, "notes": notes, "chance": chance, "events": events, "calls": model.calls})
print(json.dumps(cases))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { context: PhraseContext | null; steps: [number, [number, number][], [number, number][]][]; notes: [number, number][];
    chance: number; events: { method: string; args: [number[]]; kwargs: { weights: number[] }; value: number[] }[];
    calls: { tokens: number[]; position: number }[] }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    let position = 0;
    const calls: { tokens: number[]; position: number }[] = [];
    const logits = Float32Array.from({ length: 17727 }, (_, index) => Math.fround((index % 23 - 11) * 0.1));
    const session: AriaSession = { async run(input) {
      if (input.reset) position = 0;
      calls.push({ tokens: input.tokens, position });
      if (input.commit !== false) position += input.tokens.length;
      return { logits };
    } };
    let choice = 0;
    const phrase = new AriaPhrase(session, { choices(options, weights) {
      const event = item.events[choice++];
      assert.equal(event.method, "choices");
      assert.deepEqual(options, event.args[0]);
      weights.forEach((weight, index) => assert.ok(Math.abs(weight - event.kwargs.weights[index]) < 2e-6));
      return event.value;
    } }, item.context);
    const notes = [];
    for (const [index, [onset, pitches, durations]] of item.steps.entries()) {
      notes.push(await phrase.note(onset, new Map(pitches), new Map(durations)));
      if (index === 0) assert.ok(Math.abs(await phrase.chordChance([67, 69]) - item.chance) < 1e-7);
    }
    assert.deepEqual(notes, item.notes);
    assert.deepEqual(calls, item.calls);
    assert.equal(choice, item.events.length);
  }
});
