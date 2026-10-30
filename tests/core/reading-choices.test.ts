import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chromaticOptions, degree, introducing, noteWeight, remainingAttacks, remainingBeats } from "../../src/core/reading-choices.ts";
import type { ReadingHand, ReadingLine } from "../../src/core/reading-line.ts";
import type { MusicalKey } from "../../src/core/musical-key.ts";

test("reading pitch and remaining-rhythm choices match Python", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
from types import SimpleNamespace
from piano_duet.key_tracking import MusicalKey
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import chromatic_options, degree, introducing, note_weight, remaining_attacks, remaining_beats
hand = reading_progress([])["hands"]["treble"]
cases = []
for tonic, mode in ((0, "major"), (9, "minor"), (7, "major")):
    key = MusicalKey(tonic, mode).to_dict()
    scale = [p for p in range(60, 85) if p % 12 in key["pitch_classes"]]
    for chromatic in range(3):
        for accidental in (False, True):
            for altered in (False, True):
                line = SimpleNamespace(pool=scale[:5], accidental=accidental, altered=altered,
                    rhythms=[(1, 1, 0.5, 0.5), (1, 0.5, 0.5, 1)], prefix=(1,), cursor=1,
                    starts=[0, 1, 2, 3])
                lowest = dict.fromkeys(scale[1:4], 1.0)
                previous = scale[1]
                cases.append({"hand": hand, "key": key, "scale": scale, "stage": {"chromatic": chromatic},
                    "line": vars(line), "lowest": list(lowest.items()), "previous": previous,
                    "degrees": [degree(scale, p) for p in scale],
                    "weights": [note_weight(hand, previous, p) for p in scale[:5]],
                    "chromatic": list(chromatic_options({"chromatic": chromatic}, key, line, lowest, hand, previous).items()),
                    "attacks": remaining_attacks(line), "beats": remaining_beats(line),
                    "introductions": [introducing(2, scale[:5], scale, previous, scale[:5], remaining) for remaining in (0, 1)]})
print(json.dumps(cases))
`], { encoding: "utf8", maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { hand: ReadingHand; key: MusicalKey; scale: number[]; stage: { chromatic: number }; line: ReadingLine;
    lowest: [number, number][]; previous: number; degrees: number[]; weights: number[]; chromatic: [number, number][];
    attacks: number; beats: number; introductions: number[][] }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    assert.deepEqual(item.scale.map((pitch) => degree(item.scale, pitch)), item.degrees);
    assert.deepEqual(item.scale.slice(0, 5).map((pitch) => noteWeight(item.hand, item.previous, pitch)), item.weights);
    assert.deepEqual([...chromaticOptions(item.stage, item.key, item.line, new Map(item.lowest), item.hand, item.previous)], item.chromatic);
    assert.equal(remainingAttacks(item.line), item.attacks);
    assert.equal(remainingBeats(item.line), item.beats);
    assert.deepEqual([0, 1].map((remaining) => introducing(2, item.scale.slice(0, 5), item.scale, item.previous, item.scale.slice(0, 5), remaining)), item.introductions);
  }
});
