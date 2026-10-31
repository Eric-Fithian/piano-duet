import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ariaVocabulary, encodeContext, pianoToken } from "../../src/core/aria-tokenizer.ts";
import type { EncodedContext, PhraseContext } from "../../src/core/aria-tokenizer.ts";

test("Aria context tokens and piano vocabulary match the Python tokenizer", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, random
from types import SimpleNamespace
from ariautils.tokenizer import AbsTokenizer
from piano_duet.generation import ConstrainedPhrase
class Model:
    def setup_cache(self, *args, **kwargs): pass
tokenizer = AbsTokenizer()
ids = [i for i, tok in tokenizer.id_to_tok.items() if isinstance(tok, tuple) and tok[0] == "piano" and 21 <= tok[1] <= 108 and tok[2] > 0]
generator = SimpleNamespace(tokenizer=tokenizer, model=Model(), note_ids=ids)
contexts = [None]
for seed in range(32):
    rng = random.Random(seed)
    notes = [{"pitch": rng.randrange(21, 109), "start": start, "duration": duration, "velocity": rng.randrange(1, 128)} for start, duration in ((0.1235, 0.004), (0.1385, 0.155), (5.1335, 0.5), (10.25, 6.2))]
    contexts.append({"notes": notes, "end": 11.0})
encoded = []
for context in contexts:
    phrase = ConstrainedPhrase(generator, random.Random(1), context)
    encoded.append({"tokens": phrase.pending, "segment": phrase.segment, "onset": phrase.onset, "origin": phrase.origin})
piano = [[pitch, velocity, tokenizer.tok_to_id[("piano", pitch, tokenizer._quantize_velocity(velocity))]] for pitch in (21, 60, 108) for velocity in range(1, 128)]
phrase = ConstrainedPhrase(generator, random.Random(1))
print(json.dumps({"contexts": contexts, "encoded": encoded, "piano": piano, "pitchTokens": list(phrase.pitch_tokens.items()), "durationTokens": [(tok[1], tokenizer.tok_to_id[tok]) for tok in tokenizer.dur_tokens]}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { contexts: (PhraseContext | null)[]; encoded: EncodedContext[]; piano: [number, number, number][];
    pitchTokens: [number, number[]][]; durationTokens: [number, number][] } = JSON.parse(reference.stdout);
  assert.deepEqual(data.contexts.map(encodeContext), data.encoded);
  for (const [pitch, velocity, token] of data.piano) assert.equal(pianoToken(pitch, velocity), token);
  const vocabulary = ariaVocabulary();
  assert.deepEqual([...vocabulary.pitchTokens], data.pitchTokens);
  assert.deepEqual([...vocabulary.durationTokens], data.durationTokens);
});
