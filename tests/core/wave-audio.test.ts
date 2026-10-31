import assert from "node:assert/strict";
import test from "node:test";
import { decodeWaveAudio } from "../../src/core/wave-audio.ts";

function wave(channels: number, samples: number[]): ArrayBuffer {
  const data = new ArrayBuffer(44 + samples.length * 2), view = new DataView(data);
  const tag = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  tag(0, "RIFF"); view.setUint32(4, data.byteLength - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, 44100, true); view.setUint32(28, 44100 * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); tag(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return data;
}

test("WAV decoding mixes stereo PCM and rejects truncated files", () => {
  assert.deepEqual([...decodeWaveAudio(wave(2, [32767, -32768, 16384, 16384]))],
    [Math.fround(-Math.SQRT1_2 / 32768), Math.fround(Math.SQRT1_2)]);
  assert.throws(() => decodeWaveAudio(wave(1, [100]).slice(0, -1)), { message: "The WAV file is truncated" });
});
