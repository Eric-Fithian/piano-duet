import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { decodePhrase } from "../../src/core/phrase-transcription.ts";
import type { ContextNote } from "../../src/core/aria-tokenizer.ts";

test("full-phrase decoding matches Python for offsets, repeated notes and pedal", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import base64, json
import numpy as np
from piano_duet.transcription import decode
cases = []
for variant in range(4):
    frames = 650
    names = ('reg_onset_output', 'reg_offset_output', 'frame_output', 'velocity_output')
    prediction = {name: np.zeros((frames, 88), dtype=np.float32) for name in names}
    prediction.update({name: np.zeros((frames, 1), dtype=np.float32) for name in ('reg_pedal_onset_output', 'reg_pedal_offset_output', 'pedal_frame_output')})
    if variant:
        for index in range(13):
            pitch = (index * 11 + variant) % 60 + 12
            begin = 40 + index * 40
            end = min(frames - 10, begin + (25 if index % 2 else 65))
            if index == 7: pitch = (6 * 11 + variant) % 60 + 12
            for j, value in enumerate((.03, .11, .38, .97, .31, .08, .02)):
                prediction['reg_onset_output'][begin - 3 + j, pitch] = value
            for j, value in enumerate((.02, .04, .07, .14, .48, .10, .06, .03, .01)):
                prediction['reg_offset_output'][end - 4 + j, pitch] = value
            prediction['frame_output'][begin:end, pitch] = .86
            prediction['velocity_output'][begin, pitch] = .35 + index * .025
        prediction['pedal_frame_output'][100:240, 0] = .8
        prediction['pedal_frame_output'][350:480, 0] = .8
        for end in (240, 480):
            for j, value in enumerate((.01, .03, .05, .12, .6, .1, .04, .02, .01)):
                prediction['reg_pedal_offset_output'][end - 4 + j, 0] = value
    notes, support = decode({key: value.copy() for key, value in prediction.items()}, .8, frames, 6.0)
    ordered = sorted(zip(notes, support), key=lambda pair: (pair[0].start, pair[0].pitch))
    values = [value for _, value in ordered]
    if values:
        average = float(np.mean(values))
        fraction = sum(value >= .6 for value in values) / len(values)
        quality = {'usable': average >= .75 and fraction >= .8, 'onset_support': round(average, 3), 'supported_fraction': round(fraction, 3), 'note_support': [round(value, 3) for value in values], 'reason': 'Onset model support; not a calibrated probability of correct transcription'}
    else:
        quality = {'usable': False, 'onset_support': None, 'supported_fraction': 0, 'note_support': [], 'reason': 'No recognized notes'}
    encoded = {key: base64.b64encode(value.tobytes()).decode() for key, value in prediction.items()}
    cases.append({'frames': frames, 'prediction': encoded, 'notes': [note.model_dump() for note, _ in ordered], 'quality': quality})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { frames: number; prediction: Record<string, string>; notes: ContextNote[]; quality: unknown }[] = JSON.parse(reference.stdout);
  const floats = (encoded: string) => {
    const bytes = Buffer.from(encoded, "base64");
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  for (const item of cases) {
    const p = item.prediction;
    const result = decodePhrase({ frames: item.frames, onset: floats(p.reg_onset_output), offset: floats(p.reg_offset_output),
      frame: floats(p.frame_output), velocity: floats(p.velocity_output), pedalOffset: floats(p.reg_pedal_offset_output),
      pedalFrame: floats(p.pedal_frame_output) }, 0.8, 6);
    assert.deepEqual(result.quality, item.quality);
    assert.equal(result.notes.length, item.notes.length);
    for (let index = 0; index < result.notes.length; index++) {
      const actual = result.notes[index], expected = item.notes[index];
      assert.equal(actual.pitch, expected.pitch);
      assert.equal(actual.velocity, expected.velocity);
      assert.ok(Math.abs(actual.start - expected.start) < 1e-6);
      assert.ok(Math.abs(actual.duration - expected.duration) < 1e-6);
    }
  }
});
