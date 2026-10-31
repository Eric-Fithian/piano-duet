import { ARIA_DURATION_BASE, ARIA_ONSET_BASE, ARIA_TIME_STEP_MS, ARIA_TIME_TOKEN, ariaVocabulary, encodeContext } from "./aria-tokenizer.ts";
import type { ContextNote, EncodedContext } from "./aria-tokenizer.ts";
import type { AriaSession, SamplingRandom } from "./aria-phrase.ts";
import { constrainedDistribution } from "./constrained-sampling.ts";
import { PerformanceLimits } from "./performance-limits.ts";
import { estimateBeat, PhraseEnding } from "./phrase-ending.ts";
import { roundEven } from "./numeric.ts";

const END_TOKEN = 1;
const DIM_TOKEN = 4;
const PIANO_BASE = 39;

export class DuetDecoder {
  private readonly limits: PerformanceLimits;
  private readonly noteTokens: number[];
  private readonly pitches: number[];
  private readonly minimumOnset: number;
  private readonly durationFloor: number;
  private readonly cueAt: number;
  private readonly ending: PhraseEnding;
  private readonly history: ContextNote[] = [];
  private windows = new Map<number, [number, number][]>();
  private segment: number;
  private previousOnset: number;
  private firstOnset: number | null = null;
  private state: "note" | "onset" | "duration" = "note";
  private endingCued = false;
  private pitch = 0;
  private velocity = 0;
  private onset = 0;
  done = false;
  modelEnded = false;

  constructor(context: EncodedContext, ending: PhraseEnding, difficulty: number, pitchClasses: number[] | null) {
    if (pitchClasses !== null && (!pitchClasses.length || pitchClasses.some((pitch) => !Number.isInteger(pitch) || pitch < 0 || pitch > 11))) {
      throw new Error("A pitch constraint requires pitch classes between 0 and 11");
    }
    this.ending = ending;
    this.limits = new PerformanceLimits(difficulty, ending.beat);
    const vocabulary = ariaVocabulary();
    this.pitches = [...vocabulary.pitchTokens.keys()].filter((pitch) => this.limits.inRange(pitch) && (pitchClasses === null || pitchClasses.includes(pitch % 12)));
    this.noteTokens = this.pitches.flatMap((pitch) => vocabulary.pitchTokens.get(pitch)!);
    this.segment = context.segment;
    this.minimumOnset = context.onset + 10;
    this.previousOnset = this.minimumOnset;
    this.durationFloor = Math.max(this.limits.durationFloor, Math.max(60, Math.min(100, roundEven(ending.beat * 16) * 10)));
    this.cueAt = Math.max(0.7, ending.target - Math.max(1.2, ending.beat * 4));
  }

  options(): number[] {
    if (this.done) throw new Error("Cannot sample a completed reply");
    let allowed: number[];
    if (this.state === "note") {
      this.windows = new Map(this.pitches.map((pitch) => [pitch, this.limits.windows(pitch, this.previousOnset)]));
      const playable = new Set(this.pitches.filter((pitch) => this.windows.get(pitch)!.some(([start, end]) =>
        Math.max(start, this.segment) <= Math.min(end, this.segment + ARIA_TIME_STEP_MS - 10))));
      allowed = this.noteTokens.filter((token) => playable.has(Math.floor((token - PIANO_BASE) / 13)));
      allowed.push(ARIA_TIME_TOKEN);
      if (this.history.length) allowed.push(END_TOKEN);
      if (this.segment + ARIA_TIME_STEP_MS <= this.previousOnset) allowed = [ARIA_TIME_TOKEN];
      if (!this.endingCued && this.firstOnset !== null && ((this.previousOnset - this.firstOnset) / 1000 >= this.cueAt || this.shortLoop())) {
        allowed = [DIM_TOKEN];
      }
    } else if (this.state === "onset") {
      const windows = this.windows.get(this.pitch);
      if (!windows) throw new Error("The reply pitch has no timing windows");
      allowed = Array.from({ length: 500 }, (_, index) => ARIA_ONSET_BASE + index)
        .filter((token) => windows.some(([start, end]) => start <= (token - ARIA_ONSET_BASE) * 10 + this.segment && (token - ARIA_ONSET_BASE) * 10 + this.segment <= end));
    } else {
      const floor = this.shortLoop() ? Math.max(this.durationFloor, roundEven(this.ending.beat * 500)) : this.durationFloor;
      allowed = Array.from({ length: 500 }, (_, index) => ARIA_DURATION_BASE + index + 1).filter((token) => (token - ARIA_DURATION_BASE) * 10 >= floor);
    }
    if (!allowed.length) throw new Error("Aria has no valid next token for the current timing");
    return allowed;
  }

  accept(token: number): ContextNote | null {
    if (!this.options().includes(token)) throw new Error("Aria selected a token outside the reply constraints");
    if (token === END_TOKEN) { this.done = true; this.modelEnded = true; }
    else if (token === DIM_TOKEN) this.endingCued = true;
    else if (token === ARIA_TIME_TOKEN) {
      this.segment += ARIA_TIME_STEP_MS;
      if (this.segment > this.minimumOnset + (this.ending.horizon + 10) * 1000) throw new Error("Aria generated an excessively long rest");
    } else if (this.state === "note") {
      this.pitch = Math.floor((token - PIANO_BASE) / 13);
      this.velocity = ((token - PIANO_BASE) % 13) * 10;
      this.state = "onset";
    } else if (this.state === "onset") {
      this.onset = this.segment + (token - ARIA_ONSET_BASE) * 10;
      this.firstOnset ??= this.onset;
      if (this.onset - this.firstOnset >= this.ending.horizon * 1000) this.done = true;
      else { this.previousOnset = this.onset; this.state = "duration"; }
    } else {
      const note = { pitch: this.pitch, velocity: this.velocity, start: (this.onset - this.firstOnset!) / 1000,
        duration: (token - ARIA_DURATION_BASE) / 100 };
      this.history.push(note);
      this.limits.record(this.pitch, this.onset);
      this.state = "note";
      return note;
    }
    return null;
  }

  private shortLoop(): boolean {
    const recent = this.history.slice(-12);
    return recent.length >= 8 && recent.filter((note) => note.duration < 0.16).length >= recent.length * 0.75
      && new Set(recent.map((note) => note.pitch)).size <= 4;
  }
}

export async function* generateDuet(session: AriaSession, random: SamplingRandom, notes: ContextNote[], settings: {
  seconds: number; temperature: number; difficulty: number; tonic: number | null; pitchClasses: number[] | null; signal?: AbortSignal; maxNotes?: number;
}): AsyncGenerator<ContextNote> {
  if (!notes.length) throw new Error("Aria requires piano notes as a prompt");
  const prompt = notes.slice(-180);
  const context = encodeContext({ notes: prompt, end: Math.max(...prompt.map((note) => note.start)) });
  const ending = new PhraseEnding(settings.seconds, estimateBeat(notes), settings.tonic, settings.pitchClasses);
  const decoder = new DuetDecoder(context, ending, settings.difficulty, settings.pitchClasses);
  const maxNotes = settings.maxNotes ?? 180;
  if (!Number.isInteger(maxNotes) || maxNotes < 1) throw new Error("The reply note limit must be positive");
  if (context.tokens.length > 2048) throw new Error("The reply prompt is longer than its Aria context");
  settings.signal?.throwIfAborted();
  let logits = (await session.run({ tokens: context.tokens, reset: true }, settings.signal)).logits;
  let position = context.tokens.length, count = 0;
  for (let step = 0; step < maxNotes * 3 + 24; step++) {
    settings.signal?.throwIfAborted();
    const allowed = decoder.options();
    const distribution = constrainedDistribution(logits, new Map(allowed.map((token) => [token, 1])), settings.temperature);
    const token = random.choices([...distribution.keys()], [...distribution.values()])[0];
    const note = decoder.accept(token);
    if (decoder.done) break;
    if (note) {
      count++;
      for (const ready of ending.feed(note)) yield ready;
      if (ending.done || count >= maxNotes) break;
    }
    if (++position > 2048) throw new Error("The reply is longer than its Aria context");
    logits = (await session.run({ tokens: [token], reset: false }, settings.signal)).logits;
  }
  settings.signal?.throwIfAborted();
  for (const ready of ending.finish(decoder.modelEnded)) yield ready;
}
