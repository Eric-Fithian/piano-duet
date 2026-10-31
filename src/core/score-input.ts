import { roundEven } from "./numeric.ts";

export interface ScoreInputNote { pitch: number; start: number; duration: number; velocity: number }
export interface ScoreInputTokens { onset: number[]; duration: number[]; pitch: number[]; velocity: number[]; pad: number[] }

export function scoreInput(notes: ScoreInputNote[]): ScoreInputTokens {
  if (!notes.length) throw new Error("Score writing needs at least one note");
  const rounded = notes.flatMap((note) => {
    if (!Number.isInteger(note.pitch) || note.pitch < 21 || note.pitch > 108 || !Number.isInteger(note.velocity)
        || note.velocity < 1 || note.velocity > 127 || !Number.isFinite(note.start) || note.start < 0
        || !Number.isFinite(note.duration) || note.duration <= 0) throw new Error("Invalid score input note");
    const start = roundEven(note.start * 1000), end = roundEven((note.start + note.duration) * 1000);
    // The reference MIDI reader discards notes whose on and off events share a tick.
    return end <= start ? [] : [{ ...note, start, duration: end - start }];
  }).sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.duration - b.duration);
  if (!rounded.length) throw new Error("Score writing needs at least one note lasting a MIDI tick");
  const result: ScoreInputTokens = { onset: [], duration: [], pitch: [], velocity: [], pad: [] };
  let previous = 0;
  for (const note of rounded) {
    const onset = Math.fround(note.start / 1000), duration = Math.fround(note.duration / 1000);
    const gap = Math.fround(onset - previous);
    result.onset.push(logBucket(gap, 33));
    result.duration.push(logBucket(duration, 65));
    result.pitch.push(bucket(note.pitch, 127, 128));
    result.velocity.push(bucket(note.velocity, 127, 8));
    result.pad.push(1);
    previous = onset;
  }
  return result;
}

function logBucket(value: number, divisor: number): number {
  const scaled = Math.fround(Math.fround(Math.fround(Math.log(Math.fround(Math.fround(4 * value) + 1))) * 4)
    / Math.fround(Math.log(divisor)));
  return bucket(scaled, 4, 200);
}

function bucket(value: number, maximum: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.trunc(Math.fround(Math.fround(value / maximum) * count))));
}
