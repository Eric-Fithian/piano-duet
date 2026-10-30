import type { LiveOnset } from "./inference";

export function decodeLiveOnsets(onset: Float32Array, frame: Float32Array, velocity: Float32Array,
  frames: number, threshold: number): LiveOnset[] {
  if (onset.length !== frames * 88 || frame.length !== onset.length || velocity.length !== onset.length) {
    throw new Error("Unexpected live transcription output shape");
  }
  const notes: LiveOnset[] = [];
  for (let time = 2; time < frames - 2; time++) {
    for (let pitch = 0; pitch < 88; pitch++) {
      const at = (offset: number) => onset[(time + offset) * 88 + pitch];
      if (at(0) <= threshold || at(0) < at(-1) || at(-1) < at(-2)
          || at(0) < at(1) || at(1) < at(2)) continue;
      const shift = (at(1) - at(-1)) / (at(0) - (at(-1) > at(1) ? at(1) : at(-1))) / 2;
      const start = (time + shift) / 100;
      if (start < 0.25 || start > 1.85) continue;
      let sustained = 0;
      for (let index = time; index < Math.min(frames, time + 6); index++) {
        if (frame[index * 88 + pitch] >= 0.3) sustained++;
      }
      if (sustained < 3) continue;
      notes.push({ pitch: pitch + 21, start: Math.round(start * 10000) / 10000,
        velocity: Math.max(1, Math.min(127, roundEven(velocity[time * 88 + pitch] * 128))),
        confidence: Math.round(at(0) * 10000) / 10000 });
    }
  }
  return notes;
}

function roundEven(value: number): number {
  const floor = Math.floor(value);
  return value - floor === 0.5 && floor % 2 === 0 ? floor : Math.round(value);
}
