import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assessVariation } from "../../src/core/variation-assessment.ts";
import { musicalKey } from "../../src/core/musical-key.ts";
import type { ContextNote } from "../../src/core/aria-tokenizer.ts";

test("Variations playback assessment matches Python across keys and mistakes", () => {
  const target: ContextNote[] = [
    { pitch: 60, start: 0, duration: 0.5, velocity: 80 }, { pitch: 64, start: 0, duration: 0.5, velocity: 80 },
    { pitch: 67, start: 0, duration: 0.5, velocity: 80 }, { pitch: 65, start: 1, duration: 0.5, velocity: 80 },
    { pitch: 62, start: 2, duration: 0.5, velocity: 80 }, { pitch: 69, start: 2, duration: 0.5, velocity: 80 },
  ];
  const scenarios = [
    { target, notes: target, source: "microphone", quality: { usable: true } },
    { target, notes: target.filter((_, index) => index !== 1), source: "microphone", quality: { usable: true } },
    { target, notes: target.map((note, index) => ({ ...note, pitch: index === 3 ? 66 : note.pitch })), source: "microphone", quality: { usable: true } },
    { target, notes: [...target, { pitch: 75, start: 3, duration: 0.5, velocity: 80 }], source: "microphone", quality: { usable: true } },
    { target, notes: target.map((note) => ({ ...note, start: note.start === 2 ? 2.8 : note.start })), source: "microphone", quality: { usable: true } },
    { target, notes: target, source: "demo", quality: { usable: true } },
    { target, notes: target, source: "microphone", quality: { usable: false } },
    { target, notes: [], source: "microphone", quality: { usable: false } },
    { target: [], notes: target, source: "microphone", quality: { usable: true } },
  ];
  const cases = (["major", "minor"] as const).flatMap((mode) => Array.from({ length: 12 }, (_, tonic) =>
    scenarios.map((scenario) => ({ ...scenario, key: musicalKey(tonic, mode) }))).flat());
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.assessment import assess
from piano_duet.notes import Note
cases = json.load(sys.stdin)
result = []
for case in cases:
    prompt = {'family': 'imitation' if case['target'] else 'creating', 'challenge': 1, 'target': case['target'], 'key': case['key']}
    context = {'source': case['source'], 'notation_visible': False, 'hearings': 0, 'reveals': 0, 'hints': 0, 'familiar': False}
    result.append(assess(prompt, [Note.model_validate(note) for note in case['notes']], context, case['quality']))
print(json.dumps(result))
`], { encoding: "utf8", input: JSON.stringify(cases), maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  for (const [index, item] of cases.entries()) {
    assert.deepEqual(assessVariation(item.target, item.notes, item.key, item.source, item.quality), expected[index], `${item.key.name}, scenario ${index % scenarios.length}`);
  }
});
