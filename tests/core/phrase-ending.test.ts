import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { estimateBeat, PhraseEnding } from "../../src/core/phrase-ending.ts";
import type { ContextNote } from "../../src/core/aria-tokenizer.ts";

test("reply endings and beat estimates match Python on synthetic phrases", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, random
from piano_duet.notes import Note
from piano_duet.phrasing import PhraseEnding, estimate_beat
rng = random.Random(319)
cases = []
for index in range(400):
    target = rng.choice((2, 3, 5, 8, 12))
    tonic = rng.choice((None, 0, 3, 9))
    scale = None if tonic is None else [(tonic + n) % 12 for n in rng.choice(((0, 2, 4, 5, 7, 9, 11), (0, 2, 3, 5, 7, 8, 10)))]
    notes = []
    start = 0
    for _ in range(rng.randrange(1, 45)):
        start += rng.choice((0, 0.02, 0.03, 0.1, 0.25, 0.5, 1))
        notes.append(Note(pitch=rng.randrange(40, 85), start=start, duration=rng.choice((0.1, 0.3, 0.5, 1, 2)), velocity=80))
    beat = estimate_beat(notes)
    ending = PhraseEnding(target, beat, tonic, scale)
    releases = []
    for note in notes:
        releases.append([n.model_dump() for n in ending.feed(note)])
        if ending.done:
            break
    model_ended = index % 2 == 0
    last = [n.model_dump() for n in ending.finish(model_ended)]
    cases.append({'target': target, 'tonic': tonic, 'scale': scale, 'notes': [n.model_dump() for n in notes], 'beat': beat, 'releases': releases, 'last': last, 'reason': ending.reason, 'modelEnded': model_ended})
print(json.dumps(cases))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { target: number; tonic: number | null; scale: number[] | null; notes: ContextNote[]; beat: number;
    releases: ContextNote[][]; last: ContextNote[]; reason: string; modelEnded: boolean }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    assert.equal(estimateBeat(item.notes), item.beat);
    const ending = new PhraseEnding(item.target, item.beat, item.tonic, item.scale);
    const releases = [];
    for (const note of item.notes) {
      releases.push(ending.feed(note));
      if (ending.done) break;
    }
    assert.deepEqual(releases, item.releases);
    assert.deepEqual(ending.finish(item.modelEnded), item.last);
    assert.equal(ending.reason, item.reason);
  }
});
