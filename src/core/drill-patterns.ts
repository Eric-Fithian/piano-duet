import type { DrillConfig } from "./drill-assessment.ts";
import { DRILL_PATTERN_DATA } from "./drill-pattern-data.ts";

export type DrillPatternNote = [pitch: number, hand: string, finger: number | null];
export type DrillPattern = DrillPatternNote[][];
type Scale = readonly [readonly number[], readonly number[]];
type Fingering = readonly [readonly number[], number, number];
const SCALES: Record<string, Scale> = DRILL_PATTERN_DATA.scales;
const FINGERING: Record<string, Record<string, Record<string, Fingering>>> = DRILL_PATTERN_DATA.fingering;
const TRIADS: Record<string, readonly number[]> = DRILL_PATTERN_DATA.triads;
const CHORD_FINGERS: Record<string, readonly (readonly number[])[]> = DRILL_PATTERN_DATA.chordFingers;
const mod = (value: number, divisor: number) => (value % divisor + divisor) % divisor;

export function register(tonic: number, octaves: number, hands = "right"): number {
  const lower = octaves >= 3 || octaves === 2 && ["together", "third", "sixth"].includes(hands);
  return 60 + tonic - 12 * Number(lower);
}

function degree(intervals: readonly number[], index: number): number {
  return 12 * Math.floor(index / 7) + intervals[mod(index, 7)];
}

function scaleFingers(hand: string, variant: string, tonic: number, pitches: number[]): (number | null)[] {
  const table = FINGERING[hand]?.[variant]?.[tonic];
  if (!table) return pitches.map(() => null);
  const [cycle, bottom, top] = table, [up, down] = SCALES[variant], low = Math.min(...pitches), high = Math.max(...pitches);
  return pitches.map((pitch) => {
    const interval = mod(pitch - tonic, 12), step = up.includes(interval) ? up.indexOf(interval) : down.indexOf(interval);
    if (step < 0) throw new Error("Scale pitch is outside the fingering table");
    return step === 0 && pitch === low ? bottom : step === 0 && pitch === high ? top : cycle[step];
  });
}

function chromaticFingers(hand: string, pitches: number[]): number[] {
  const paired = hand === "right" ? [5, 0] : [4, 11];
  const fingers = pitches.map((pitch) => [1, 3, 6, 8, 10].includes(mod(pitch, 12)) ? 3 : paired.includes(mod(pitch, 12)) ? 2 : 1);
  if (paired.includes(mod(pitches[0], 12))) fingers[0] = 1;
  return fingers;
}

function line(pitches: number[], hand: string, fingers: (number | null)[] = pitches.map(() => null)): DrillPattern {
  if (pitches.length !== fingers.length) throw new Error("Fingering length does not match pitches");
  return pitches.map((pitch, index) => [[pitch, hand, fingers[index]]]);
}

function merge(...voices: DrillPattern[]): DrillPattern {
  if (!voices.length || voices.some((voice) => voice.length !== voices[0].length)) throw new Error("Both hands must play the same number of attacks");
  return voices[0].map((_, index) => voices.flatMap((voice) => voice[index]));
}

const thereAndBack = (ascending: number[]) => [...ascending, ...ascending.slice(0, -1).reverse()];

function scaleLine(start: number, variant: string, octaves: number, offset = 0): number[] {
  const [up, down] = SCALES[variant], count = 7 * octaves;
  const ascending = Array.from({ length: count + 1 }, (_, index) => start + degree(up, offset + index) - degree(up, offset));
  const descending = Array.from({ length: count }, (_, index) => start + degree(down, offset + count - index - 1) - degree(up, offset));
  return [...ascending, ...descending];
}

function scaleEvents(variant: string, tonic: number, hands: string, octaves: number): DrillPattern {
  const base = register(tonic, octaves, hands), third = SCALES[variant][0][2];
  const voice = (hand: string, pitches: number[]) => line(pitches, hand, scaleFingers(hand, variant, tonic, pitches));
  if (hands === "right") return voice("right", scaleLine(base, variant, octaves));
  if (hands === "left") return voice("left", scaleLine(base - (octaves === 2 ? 24 : 12), variant, octaves));
  if (hands === "contrary") {
    const left = thereAndBack(Array.from({ length: 7 * octaves + 1 }, (_, step) => base + degree(SCALES[variant][0], -step)));
    return merge(voice("right", scaleLine(base, variant, octaves)), voice("left", left));
  }
  let right: number[], left: number[];
  if (hands === "together") { right = scaleLine(base, variant, octaves); left = right.map((pitch) => pitch - 12); }
  else if (hands === "third") { left = scaleLine(base - 12, variant, octaves); right = scaleLine(base + third, variant, octaves, 2); }
  else { right = scaleLine(base, variant, octaves); left = scaleLine(base - 12 + third, variant, octaves, 2); }
  return merge(voice("right", right), voice("left", left));
}

function fiveFingerEvents(variant: string, tonic: number, hands: string): DrillPattern {
  const up = SCALES[variant][0], base = register(tonic, 1), steps = [0, 1, 2, 3, 4, 3, 2, 1, 0];
  const right = line(steps.map((step) => base + up[step]), "right", steps.map((step) => step + 1));
  const lower = line(steps.map((step) => base - 12 + up[step]), "left", steps.map((step) => 5 - step));
  if (hands === "right") return right;
  if (hands === "left") return lower;
  if (hands === "together") return merge(right, lower);
  return merge(right, line(steps.map((step) => base + degree(up, -step)), "left", steps.map((step) => step + 1)));
}

function chromaticEvents(tonic: number, hands: string, octaves: number): DrillPattern {
  const base = register(tonic, octaves, hands), right = thereAndBack(Array.from({ length: 12 * octaves + 1 }, (_, step) => base + step));
  const left = right.map((pitch) => hands === "contrary" ? 2 * base - pitch : pitch - 12);
  if (hands === "right") return line(right, "right", chromaticFingers("right", right));
  if (hands === "left") return line(left, "left", chromaticFingers("left", left));
  return merge(line(right, "right", chromaticFingers("right", right)), line(left, "left", chromaticFingers("left", left)));
}

function arpeggioEvents(chord: readonly number[], base: number, hands: string, octaves: number, inversion: number): DrillPattern {
  const size = chord.length;
  const right = thereAndBack(Array.from({ length: size * octaves + 1 }, (_, offset) => {
    const index = inversion + offset;
    return base + 12 * Math.floor(index / size) + chord[index % size];
  }));
  const voices: DrillPattern[] = [];
  if (["right", "together"].includes(hands)) voices.push(line(right, "right"));
  if (["left", "together"].includes(hands)) voices.push(line(right.map((pitch) => pitch - 12), "left"));
  return merge(...voices);
}

function triadPositions(base: number, triad: readonly number[]): number[][] {
  const root = triad.map((interval) => base + interval);
  return [root, [root[1], root[2], root[0] + 12], [root[2], root[0] + 12, root[1] + 12], root.map((pitch) => pitch + 12)];
}

function chordEvent(pitches: number[], shape: number, hands: string, order = [0, 1, 2]): DrillPatternNote[] {
  const event: DrillPatternNote[] = [];
  for (const [hand, shift] of [["right", 0], ["left", -12]] as const) {
    if ([hand, "together"].includes(hands)) for (const index of order) event.push([pitches[index] + shift, hand, CHORD_FINGERS[hand][shape][index]]);
  }
  return event;
}

function chordEvents(triad: readonly number[], tonic: number, hands: string, broken: boolean): DrillPattern {
  const positions = triadPositions(register(tonic, 1), triad), shapes = [0, 1, 2, 0];
  if (!broken) return [0, 1, 2, 3, 2, 1, 0].map((index) => chordEvent(positions[index], shapes[index], hands));
  const events: DrillPattern = [];
  for (const index of [0, 1, 2, 3]) for (const finger of [0, 1, 2]) events.push(chordEvent(positions[index], shapes[index], hands, [finger]));
  for (const index of [3, 2, 1, 0]) for (const finger of [2, 1, 0]) events.push(chordEvent(positions[index], shapes[index], hands, [finger]));
  return events;
}

function voiceLead(previous: number[], pitchClasses: number[]): number[] {
  let best: { cost: number; chord: number[] } | undefined;
  const desired = [...pitchClasses].sort((a, b) => a - b).join(",");
  for (let low = previous[0] - 7; low < previous[0] + 8; low++) for (let middle = low + 1; middle < low + 12; middle++) for (let high = middle + 1; high < low + 13; high++) {
    const chord = [low, middle, high];
    if (chord.map((pitch) => mod(pitch, 12)).sort((a, b) => a - b).join(",") !== desired) continue;
    const cost = chord.reduce((sum, pitch, index) => sum + Math.abs(pitch - previous[index]), 0);
    if (!best || cost < best.cost) best = { cost, chord };
  }
  if (!best) throw new Error("No close voicing exists for this cadence chord");
  return best.chord;
}

function cadenceEvents(variant: string, tonic: number, inversion: number): DrillPattern {
  const base = register(tonic, 1), third = TRIADS[variant][1], home = triadPositions(base, TRIADS[variant])[inversion];
  const progression: [number, number[] | null][] = [[0, null], [5, [0, third, 7]], [7, [0, 4, 10]], [0, null]];
  let voicing = home, bass = base - 12;
  return progression.map(([root, chord]) => {
    voicing = chord === null ? home : voiceLead(voicing, chord.map((pitch) => mod(tonic + root + pitch, 12)));
    const choices = Array.from({ length: 16 }, (_, index) => base - 19 + index).filter((pitch) => mod(pitch, 12) === mod(tonic + root, 12));
    bass = choices.reduce((best, pitch) => Math.abs(pitch - bass) < Math.abs(best - bass) ? pitch : best);
    return [[bass, "left", null], ...voicing.map((pitch): DrillPatternNote => [pitch, "right", null])];
  });
}

function hanonEvents(tonic: number, hands: string, octaves: number): DrillPattern {
  const up = SCALES.major[0], base = register(tonic, 1) - 12 * (octaves - 1), groups = 7 * octaves;
  const rising = [0, 2, 3, 4, 5, 4, 3, 2], top = groups - 1 + 5;
  const steps = Array.from({ length: groups }, (_, start) => rising.map((step) => start + step)).flat();
  steps.push(...Array.from({ length: groups }, (_, start) => rising.map((step) => top - start - step)).flat(), 0);
  const fingers: Record<string, number[]> = {
    right: [...Array.from({ length: groups }, () => [1, 2, 3, 4, 5, 4, 3, 2]).flat(), ...Array.from({ length: groups }, () => [5, 4, 3, 2, 1, 2, 3, 4]).flat(), 1],
    left: [...Array.from({ length: groups }, () => [5, 4, 3, 2, 1, 2, 3, 4]).flat(), ...Array.from({ length: groups }, () => [1, 2, 3, 4, 5, 4, 3, 2]).flat(), 5],
  };
  const voices: DrillPattern[] = [];
  for (const [hand, shift] of [["right", 0], ["left", -12]] as const) if ([hand, "together"].includes(hands)) {
    voices.push(line(steps.map((step) => base + shift + degree(up, step)), hand, fingers[hand]));
  }
  return merge(...voices);
}

export function drillPattern(config: DrillConfig): DrillPattern {
  const { drill, variant, tonic, hands, octaves, inversion } = config;
  if (drill === "five_finger") return fiveFingerEvents(variant, tonic, hands);
  if (drill === "scale") return scaleEvents(variant, tonic, hands, octaves);
  if (drill === "chromatic") return chromaticEvents(tonic, hands, octaves);
  if (drill === "arpeggio") return arpeggioEvents(TRIADS[variant], register(tonic, octaves, hands), hands, octaves, inversion);
  if (drill === "seventh_arpeggio") return variant === "dominant 7th"
    ? arpeggioEvents([0, 4, 7, 10], register((tonic + 7) % 12, octaves, hands), hands, octaves, 0)
    : arpeggioEvents([0, 3, 6, 9], register(tonic, octaves, hands), hands, octaves, 0);
  if (drill === "broken_chord" || drill === "block_chord") return chordEvents(TRIADS[variant], tonic, hands, drill === "broken_chord");
  if (drill === "cadence") return cadenceEvents(variant, tonic, inversion);
  return hanonEvents(tonic, hands, octaves);
}
