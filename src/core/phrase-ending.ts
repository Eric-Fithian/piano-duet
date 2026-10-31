import { median } from "./numeric.ts";
import type { ContextNote } from "./aria-tokenizer.ts";

export function estimateBeat(notes: ContextNote[]): number {
  const starts: number[] = [];
  for (const note of [...notes].sort((a, b) => a.start - b.start)) {
    if (!starts.length || note.start - starts.at(-1)! > 0.04) starts.push(note.start);
  }
  const intervals = starts.slice(1).map((start, index) => start - starts[index]).filter((interval) => interval >= 0.1 && interval <= 1.5);
  return intervals.length ? Math.max(0.3, Math.min(1, median(intervals))) : 0.5;
}

export class PhraseEnding {
  readonly horizon: number;
  readonly target: number;
  readonly beat: number;
  private readonly tonic: number | null;
  private readonly triad: Set<number>;
  private readonly tailStart: number;
  private readonly notes: ContextNote[] = [];
  private groupStart = 0;
  private released = 0;
  private readonly candidates: [number, number][] = [];
  done = false;
  reason: string | null = null;

  constructor(target: number, beat = 0.5, tonic: number | null = null, pitchClasses: number[] | null = null) {
    this.target = target; this.beat = beat; this.tonic = tonic;
    const third = pitchClasses && tonic !== null && pitchClasses.includes((tonic + 3) % 12) ? 3 : 4;
    this.triad = new Set(tonic === null ? [] : [0, third, 7].map((interval) => (tonic + interval) % 12));
    this.horizon = target + Math.max(3, Math.min(6, target * 0.6));
    this.tailStart = Math.max(0.5, target * 0.65);
  }

  feed(note: ContextNote): ContextNote[] {
    if (this.done) throw new Error("Cannot extend a completed reply");
    if (this.notes.length && note.start < this.notes.at(-1)!.start) throw new Error("Reply notes must arrive in onset order");
    let released: ContextNote[] = [];
    if (this.notes.length && note.start - this.notes[this.groupStart].start > 0.04) {
      const group = this.notes.slice(this.groupStart), [score, pause, resolution] = this.boundary(group, note.start);
      if (group[0].start >= this.tailStart) {
        this.candidates.push([score, this.notes.length]);
        const longEnough = group[0].start + Math.min(Math.max(...group.map((item) => item.duration)), this.beat) >= this.target * 0.85;
        if (longEnough && (pause || resolution)) {
          this.done = true; this.reason = pause ? "pause" : "resolution";
          return this.release(this.notes.length);
        }
      } else released = this.release(this.notes.length);
      this.groupStart = this.notes.length;
    }
    this.notes.push(note);
    return released;
  }

  private boundary(group: ContextNote[], nextStart: number): [number, boolean, boolean] {
    const start = group[0].start, pitches = new Set(group.map((note) => note.pitch % 12));
    const melody = Math.max(...group.map((note) => note.pitch)) % 12, longest = Math.max(...group.map((note) => note.duration));
    const sounding = this.notes.filter((note) => note.start + note.duration > start);
    const bass = Math.min(...sounding.map((note) => note.pitch)) % 12;
    const prior = this.notes.slice(0, this.groupStart), priorStart = prior.length ? prior.at(-1)!.start : -1;
    const priorPitches = prior.filter((note) => note.start >= priorStart - 0.04).map((note) => note.pitch);
    const priorMelody = ((priorPitches.length ? Math.max(...priorPitches) : -100) % 12 + 12) % 12;
    const tonicChord = this.tonic !== null && pitches.has(this.tonic) && pitches.size >= 2 && [...pitches].every((pitch) => this.triad.has(pitch));
    const tonicMelody = melody === this.tonic;
    const stepResolution = this.tonic !== null && tonicMelody && [(this.tonic + 11) % 12, (this.tonic + 2) % 12].includes(priorMelody);
    const held = longest >= this.beat * 0.7;
    const tonalScore = 3 * Number(tonicChord) + 2 * Number(tonicMelody) + Number(stepResolution) + 0.5 * Number(bass === this.tonic);
    const release = Math.max(...this.notes.map((note) => note.start + note.duration));
    const silence = nextStart - release, onsetGap = nextStart - start;
    const realPause = silence >= Math.max(0.15, this.beat * 0.35), spacious = onsetGap >= this.beat * 1.5;
    const settled = !this.triad.size || this.triad.has(melody) || silence >= this.beat * 2.5;
    const pause = realPause && onsetGap >= this.beat && settled;
    const resolution = held && (tonicChord || stepResolution || (tonicMelody && spacious));
    const durationScore = Math.min(2, longest / this.beat) * 0.6;
    const proximity = Math.abs(start + Math.min(longest, this.beat) - this.target) / this.beat;
    return [tonalScore + durationScore + 3 * Number(pause) + Number(spacious) - 0.3 * proximity, pause, resolution];
  }

  private release(end: number): ContextNote[] {
    const result = this.notes.slice(this.released, end); this.released = end; return result;
  }

  finish(modelEnded = false): ContextNote[] {
    if (this.done) return [];
    this.done = true;
    if (modelEnded) { this.reason = "model"; return this.release(this.notes.length); }
    if (this.candidates.length) {
      this.reason = "best_boundary";
      const best = this.candidates.reduce((a, b) => b[0] > a[0] || b[0] === a[0] && b[1] > a[1] ? b : a);
      return this.release(best[1]);
    }
    this.reason = "short_phrase";
    return this.release(this.groupStart || this.notes.length);
  }
}
