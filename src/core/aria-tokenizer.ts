import { roundEven } from "./numeric.ts";
import type { PhraseVocabulary } from "./constrained-sampling.ts";

export interface ContextNote { pitch: number; start: number; duration: number; velocity: number }
export interface PhraseContext { notes: ContextNote[]; end: number }
export interface EncodedContext { tokens: number[]; segment: number; onset: number; origin: number }

export const ARIA_TIME_TOKEN = 5;
export const ARIA_TIME_STEP_MS = 5000;
export const ARIA_ONSET_BASE = 17227;
export const ARIA_DURATION_BASE = 16726;
const PIANO_BASE = 39;
const VELOCITIES = Array.from({ length: 13 }, (_, index) => index * 10);
const ONSETS = Array.from({ length: 500 }, (_, index) => index * 10);
const DURATIONS = Array.from({ length: 501 }, (_, index) => index * 10);

function closest(value: number, options: number[]): number {
  let left = 0;
  let right = options.length - 1;
  let best = options[0];
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (Math.abs(options[mid] - value) < Math.abs(best - value)) best = options[mid];
    if (options[mid] < value) left = mid + 1;
    else right = mid - 1;
  }
  return best;
}

export function pianoToken(pitch: number, velocity: number): number {
  if (!Number.isInteger(pitch) || pitch < 21 || pitch > 108 || !Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
    throw new Error("Aria context notes need a piano pitch and MIDI velocity");
  }
  const quantized = closest(velocity, VELOCITIES) || 10;
  return PIANO_BASE + pitch * 13 + quantized / 10;
}

export function ariaVocabulary(): PhraseVocabulary {
  const pitchTokens = new Map<number, number[]>();
  for (let pitch = 21; pitch <= 108; pitch++) {
    pitchTokens.set(pitch, VELOCITIES.slice(1).map((velocity) => PIANO_BASE + pitch * 13 + velocity / 10));
  }
  return { pitchTokens, durationTokens: new Map(DURATIONS.map((ms) => [ms, ARIA_DURATION_BASE + ms / 10])), maxDurationMs: 5000 };
}

export function encodeContext(context: PhraseContext | null): EncodedContext {
  const tokens = [6, 0];
  if (context === null) return { tokens, segment: 0, onset: 0, origin: 0 };
  if (!context.notes.length) throw new Error("Context for a constrained phrase needs notes");
  const notes = [...context.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  for (const note of notes) {
    if (!Number.isFinite(note.start) || note.start < 0 || !Number.isFinite(note.duration) || note.duration <= 0) {
      throw new Error("Aria context notes need finite starts and positive durations");
    }
    pianoToken(note.pitch, note.velocity);
  }
  if (!Number.isFinite(context.end) || context.end < notes.at(-1)!.start) throw new Error("A phrase's context must end after its last onset");
  const firstTick = roundEven(notes[0].start * 1000);
  let segment = 0;
  let onset = 0;
  for (const note of notes) {
    const startTick = roundEven(note.start * 1000);
    const endTick = roundEven((note.start + note.duration) * 1000);
    const time = startTick - firstTick;
    while (time >= segment + ARIA_TIME_STEP_MS) { tokens.push(ARIA_TIME_TOKEN); segment += ARIA_TIME_STEP_MS; }
    const start = closest(time - segment, ONSETS);
    const duration = closest(endTick - startTick, DURATIONS) || 10;
    tokens.push(pianoToken(note.pitch, note.velocity), ARIA_ONSET_BASE + start / 10, ARIA_DURATION_BASE + duration / 10);
    onset = segment + start;
  }
  return { tokens, segment, onset, origin: context.end - notes[0].start };
}
