import { resampleTo441 } from "./resample.ts";

export function decodeWaveAudio(data: ArrayBuffer): Float32Array {
  const view = new DataView(data);
  const tag = (offset: number) => String.fromCharCode(...new Uint8Array(data, offset, 4));
  if (data.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Expected a WAV audio file");
  const limit = view.getUint32(4, true) + 8;
  if (limit > data.byteLength || limit < 12) throw new Error("The WAV file is truncated");
  let format = 0, channels = 0, rate = 0, bits = 0, align = 0, audioStart = -1, audioBytes = 0;
  for (let offset = 12; offset + 8 <= limit;) {
    const kind = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8, end = start + size;
    if (end > limit) throw new Error("The WAV file contains a truncated chunk");
    if (kind === "fmt ") {
      if (size < 16) throw new Error("The WAV format is incomplete");
      format = view.getUint16(start, true); channels = view.getUint16(start + 2, true);
      rate = view.getUint32(start + 4, true); align = view.getUint16(start + 12, true); bits = view.getUint16(start + 14, true);
    } else if (kind === "data") { audioStart = start; audioBytes = size; }
    offset = end + size % 2;
  }
  if (audioStart < 0 || !channels || channels > 2 || rate < 8000 || rate > 192000
      || !((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && [32, 64].includes(bits)))
      || align !== channels * bits / 8 || audioBytes % align !== 0 || !audioBytes) {
    throw new Error("This WAV encoding or sample rate is not supported yet");
  }
  const frames = audioBytes / align, audio = new Float32Array(frames), width = bits / 8;
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const offset = audioStart + frame * align + channel * width;
      let sample: number;
      if (format === 3) sample = bits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
      else if (bits === 8) sample = (view.getUint8(offset) - 128) / 128;
      else if (bits === 16) sample = view.getInt16(offset, true) / 32768;
      else if (bits === 24) sample = (view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getInt8(offset + 2) << 16) / 8388608;
      else sample = view.getInt32(offset, true) / 2147483648;
      if (!Number.isFinite(sample)) throw new Error("The WAV file contains invalid audio samples");
      sum = Math.fround(sum + Math.fround(sample));
    }
    audio[frame] = channels === 2 ? Math.fround(sum * Math.SQRT1_2) : sum;
  }
  return resampleTo441(audio, rate);
}
