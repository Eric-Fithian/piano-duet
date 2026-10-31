import { ARIA_ONSET_BASE, ARIA_TIME_STEP_MS, ARIA_TIME_TOKEN, ariaVocabulary, encodeContext } from "./aria-tokenizer.ts";
import type { PhraseContext } from "./aria-tokenizer.ts";
import { constrainedDistribution, durationMask, pitchMask } from "./constrained-sampling.ts";
import type { PhraseWriter } from "./reading-chord.ts";
import { roundEven } from "./numeric.ts";

export interface AriaSession {
  run(input: { tokens: number[]; reset: boolean; commit?: boolean }, signal?: AbortSignal): Promise<{ logits: Float32Array }>;
}
export interface SamplingRandom { choices(options: number[], weights: number[]): number[] }

export class AriaPhrase implements PhraseWriter {
  private readonly vocabulary = ariaVocabulary();
  private readonly origin: number;
  private pending: number[];
  private segment: number;
  private onset: number;
  private pitch: number | null = null;
  private position = 0;
  private logits?: Float32Array;
  private readonly session: AriaSession;
  private readonly rng: SamplingRandom;

  constructor(session: AriaSession, rng: SamplingRandom, context: PhraseContext | null = null) {
    this.session = session;
    this.rng = rng;
    const encoded = encodeContext(context);
    this.pending = encoded.tokens;
    this.segment = encoded.segment;
    this.onset = encoded.onset;
    this.origin = encoded.origin;
  }

  async note(onset: number, pitches: Map<number, number>, durations: Map<number, number>): Promise<[number, number]> {
    const milliseconds = roundEven((this.origin + onset) * 100) * 10;
    if (milliseconds < this.onset) throw new Error("A constrained phrase must be written in time order");
    if (this.pitch !== null && milliseconds === this.onset && Math.min(...pitches.keys()) <= this.pitch) {
      throw new Error("Notes sharing an onset must be written from low to high");
    }
    this.onset = milliseconds;
    while (milliseconds >= this.segment + ARIA_TIME_STEP_MS) { this.pending.push(ARIA_TIME_TOKEN); this.segment += ARIA_TIME_STEP_MS; }
    const pitchToken = await this.choose(pitchMask(this.vocabulary, pitches));
    this.pending.push(pitchToken, ARIA_ONSET_BASE + (milliseconds - this.segment) / 10);
    const options = durationMask(this.vocabulary, durations);
    const durationToken = await this.choose(new Map([...options].map(([token, value]) => [token, value.weight])));
    this.pending.push(durationToken);
    this.pitch = Math.floor((pitchToken - 39) / 13);
    return [this.pitch, options.get(durationToken)!.seconds];
  }

  async chordChance(pitches: number[]): Promise<number> {
    const logits = await this.advance();
    const probabilities = softmax(logits);
    const same = ARIA_ONSET_BASE + (this.onset - this.segment) / 10;
    let total = 0;
    for (const pitch of pitches) {
      const tokens = this.vocabulary.pitchTokens.get(pitch);
      if (!tokens) throw new Error("Constrained pitches must be piano keys");
      const mass = tokens.reduce((sum, token) => sum + probabilities[token], 0);
      if (mass < 1e-6) continue;
      if (this.position + 1 > 2048) throw new Error("The constrained phrase is longer than its Aria context");
      const probe = tokens.reduce((best, token) => probabilities[token] > probabilities[best] ? token : best);
      const prediction = await this.session.run({ tokens: [probe], reset: false, commit: false });
      total += mass * softmax(prediction.logits)[same];
    }
    return Math.min(1, total);
  }

  private async choose(options: Map<number, number>): Promise<number> {
    if (!options.size || [...options.values()].some((weight) => !(weight > 0))) throw new Error("A constrained choice needs options with positive weights");
    if (options.size === 1) return options.keys().next().value!;
    const probabilities = constrainedDistribution(await this.advance(), options);
    return this.rng.choices([...probabilities.keys()], [...probabilities.values()])[0];
  }

  private async advance(): Promise<Float32Array> {
    if (!this.pending.length) {
      if (!this.logits) throw new Error("Aria has no cached logits");
      return this.logits;
    }
    const count = this.pending.length;
    if (this.position + count > 2048) throw new Error("The constrained phrase is longer than its Aria context");
    const result = await this.session.run({ tokens: this.pending, reset: this.position === 0 });
    this.position += count;
    this.pending = [];
    this.logits = result.logits;
    return result.logits;
  }
}

function softmax(logits: Float32Array): Float64Array {
  if (!logits.length) throw new Error("Aria returned no logits");
  let maximum = -Infinity;
  for (const value of logits) maximum = Math.max(maximum, value / 0.95);
  let total = 0;
  const probabilities = Float64Array.from(logits, (value) => { const mass = Math.exp(value / 0.95 - maximum); total += mass; return mass; });
  return probabilities.map((value) => value / total);
}
