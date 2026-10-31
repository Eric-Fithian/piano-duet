import { ariaVocabulary, encodeContext } from "./aria-tokenizer.ts";
import type { ContextNote } from "./aria-tokenizer.ts";
import type { AriaSession } from "./aria-phrase.ts";

export interface VariationDetail {
  index: number; start: number; played: number; expected: number; corrected: number; probability: number;
  expected_probability: number; surprise: number; changed: boolean; chord_collision: boolean;
}

export async function analyzeVariation(session: AriaSession, input: ContextNote[], threshold: number, signal?: AbortSignal,
  onNote?: (detail: VariationDetail, progress: number) => void): Promise<{ notes: ContextNote[]; analysis: VariationDetail[] }> {
  if (!input.length || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Learning requires notes and a surprise threshold between 0 and 1");
  const notes = [...input].sort((a, b) => a.start - b.start || a.pitch - b.pitch), origin = notes[0].start;
  const vocabulary = ariaVocabulary(), noteTokens = [...vocabulary.pitchTokens.values()].flat(), pianoTokens = new Set(noteTokens);
  const groups: { start: number; pitches: Set<number> }[] = [];
  for (const note of notes) {
    let group = groups.at(-1);
    if (!group || note.start > group.start + 0.07) { group = { start: note.start, pitches: new Set() }; groups.push(group); }
    group.pitches.add(note.pitch);
  }
  const corrected: ContextNote[] = [], analysis: VariationDetail[] = [];
  let groupIndex = -1, chordStart = -1, chordPitches = new Set<number>();
  for (let block = 0; block < notes.length; block += 64) {
    signal?.throwIfAborted();
    const start = Math.max(0, block - 448), stop = Math.min(notes.length, block + 64), context = notes.slice(start, stop);
    const encoded = encodeContext({ notes: context, end: Math.max(...context.map((note) => note.start)) }).tokens;
    const positions = encoded.flatMap((token, index) => pianoTokens.has(token) ? [index] : []);
    if (positions.length !== context.length) throw new Error("Aria tokenization changed the number of played notes");
    let position = positions[block - start];
    let logits = (await session.run({ tokens: encoded.slice(0, position), reset: true }, signal)).logits;
    for (let index = block; index < stop; index++) {
      signal?.throwIfAborted();
      const note = notes[index], distribution = pitchProbabilities(logits, noteTokens);
      const probability = distribution[note.pitch - 21];
      const expected = distribution.reduce((best, value, pitch) => value > distribution[best] ? pitch : best, 0) + 21;
      const surprise = 1 - probability;
      if (note.start > chordStart + 0.07) { chordStart = note.start; chordPitches = new Set(); groupIndex++; }
      const change = surprise > threshold && expected !== note.pitch;
      const collision = change && (chordPitches.has(expected) || groups[groupIndex].pitches.has(expected));
      const chosen = change && !collision ? expected : note.pitch;
      chordPitches.add(chosen);
      corrected.push({ ...note, pitch: chosen, start: note.start - origin });
      const detail = { index, start: note.start - origin, played: note.pitch, expected, corrected: chosen, probability,
        expected_probability: distribution[expected - 21], surprise, changed: chosen !== note.pitch, chord_collision: collision };
      analysis.push(detail); onNote?.(detail, (index + 1) / notes.length);
      if (index + 1 === stop) continue;
      const end = positions[index + 1 - start];
      logits = (await session.run({ tokens: encoded.slice(position, end), reset: false }, signal)).logits;
      position = end;
    }
  }
  return { notes: corrected, analysis };
}

function pitchProbabilities(logits: Float32Array, tokens: number[]): number[] {
  if (tokens.some((token) => token >= logits.length || !Number.isFinite(logits[token]))) throw new Error("Aria returned invalid pitch logits");
  const maximum = Math.max(...tokens.map((token) => logits[token]));
  const masses = tokens.map((token) => Math.exp(logits[token] - maximum));
  const total = masses.reduce((sum, mass) => sum + mass, 0);
  if (!(total > 0) || !Number.isFinite(total)) throw new Error("Aria returned invalid pitch probabilities");
  const pitches = Array<number>(88).fill(0);
  for (let index = 0; index < tokens.length; index++) pitches[Math.floor((tokens[index] - 39) / 13) - 21] += masses[index] / total;
  return pitches;
}
