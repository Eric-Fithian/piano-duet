import { roundEven } from "./numeric.ts";

export interface PhraseVocabulary {
  pitchTokens: Map<number, number[]>;
  durationTokens: Map<number, number>;
  maxDurationMs: number;
}

export function pitchMask(vocabulary: PhraseVocabulary, pitches: Map<number, number>): Map<number, number> {
  const options = new Map<number, number>();
  for (const [pitch, weight] of pitches) {
    const tokens = vocabulary.pitchTokens.get(pitch);
    if (!tokens) throw new Error("Constrained pitches must be piano keys");
    for (const token of tokens) options.set(token, weight);
  }
  return options;
}

export function durationMask(vocabulary: PhraseVocabulary, durations: Map<number, number>): Map<number, { seconds: number; weight: number }> {
  const options = new Map<number, { seconds: number; weight: number }>();
  for (const [seconds, weight] of durations) {
    const milliseconds = Math.min(vocabulary.maxDurationMs, roundEven(seconds * 100) * 10);
    const token = vocabulary.durationTokens.get(milliseconds);
    if (token === undefined) throw new Error(`No Aria duration token for ${milliseconds} ms`);
    if (options.has(token)) throw new Error("Two offered durations map to the same Aria token");
    options.set(token, { seconds, weight });
  }
  return options;
}

export function constrainedDistribution(logits: ArrayLike<number>, options: Map<number, number>, temperature = 0.95, minP = 0.035): Map<number, number> {
  if (!options.size || [...options.values()].some((weight) => !(weight > 0))) throw new Error("A constrained choice needs options with positive weights");
  if (!(temperature > 0) || !(minP > 0 && minP <= 1)) throw new Error("Invalid sampling parameters");
  if (options.size === 1) return new Map([[options.keys().next().value!, 1]]);
  const scores = [...options].map(([token, weight]) => {
    if (token < 0 || token >= logits.length || !Number.isFinite(logits[token])) throw new Error(`Invalid logit for token ${token}`);
    return [token, logits[token] / temperature + Math.log(weight)] as const;
  });
  const maximum = Math.max(...scores.map(([, score]) => score));
  const cutoff = maximum + Math.log(minP);
  const masses = scores.map(([token, score]) => [token, score >= cutoff ? Math.exp(score - maximum) : 0] as const);
  const total = masses.reduce((sum, [, mass]) => sum + mass, 0);
  return new Map(masses.map(([token, mass]) => [token, mass / total]));
}
