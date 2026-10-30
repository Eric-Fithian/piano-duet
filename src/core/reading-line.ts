import { barRhythms, beatGroups, beatStarts, restPositions } from "./reading-rhythm.ts";
import type { MusicalKey } from "./musical-key.ts";

export interface LineStage {
  id: string;
  rhythm: string;
  texture: string;
  span: number;
  step: number;
  shift: number;
  rest_probability: number;
  fingering: boolean;
}
export interface ReadingHand {
  pitches: Record<string, { accuracy: number | null; samples: number }>;
  starting_pitches: Record<string, { accuracy: number | null; samples: number }>;
  fluency: { landings: { pitch: number; samples: number }[] };
  movements: Record<string, { accuracy: number | null }>;
}
export interface LineRandom {
  choice<T>(options: T[]): T;
  choices(options: number[], weights: number[]): number[];
  random(): number;
}
export interface ReadingNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  staff: string;
  finger?: number;
}
export interface ReadingLine {
  staff: string;
  melody: boolean;
  scale: number[];
  pool: number[];
  anchor: number | null;
  rhythms: number[][];
  endings: Map<number, number>;
  cue: { staff: string; low: number; note: ReadingNote | null } | null;
  finger: number | null;
  history: number[];
  starts: number[];
  accidental: boolean;
  introduced: boolean;
  altered: boolean;
  chorded: boolean;
  prefix: number[];
  cursor: number;
  pitches: number[];
}

export function variedOptions<T>(options: Map<number, T>, history: number[], avoid: number[] = []): Map<number, T> {
  const triple = (pitch: number) => history.length >= 2 && history.at(-1) === pitch && history.at(-2) === pitch || avoid.includes(pitch);
  const swing = (pitch: number) => history.length >= 4 && pitch === history.at(-2) && pitch === history.at(-4) && pitch !== history.at(-1) && history.at(-1) === history.at(-3);
  const filtered = (predicate: (pitch: number) => boolean) => new Map([...options].filter(([pitch]) => predicate(pitch)));
  const varied = filtered((pitch) => !triple(pitch) && !swing(pitch));
  if (varied.size) return varied;
  const notTriple = filtered((pitch) => !triple(pitch));
  return notTriple.size ? notTriple : options;
}

export function pitchNeed(hand: ReadingHand, pitch: number, landing = false): number {
  const stats = (landing ? hand.starting_pitches : hand.pitches)[String(pitch)];
  const accuracy = stats?.accuracy ?? 0;
  const samples = landing ? hand.fluency.landings.find((row) => row.pitch === pitch)?.samples ?? 0 : stats?.samples ?? 0;
  return 1 + (100 - accuracy) / 20 + 4 / (1 + samples);
}

export function movementNeed(hand: ReadingHand, first: number, second: number): number {
  return 1 + (100 - (hand.movements[String(second - first)]?.accuracy ?? 0)) / 25;
}

export function planLine(stage: LineStage, hands: Record<string, ReadingHand>, key: MusicalKey, meter: string,
  clef: string, staff: string, bar: number, scale: number[], previous: number | null, history: number[], rng: LineRandom,
  shift: boolean, figure: boolean, accidental: boolean): ReadingLine {
  const melody = staff === "treble" || clef !== "grand";
  const style = melody || stage.texture === "alternating" ? stage.rhythm
    : ["independent", "voicings"].includes(stage.texture) ? "eighths" : "held";
  const span = Math.min(stage.span, scale.length - 2);
  const cadences: [number, number][] = [];
  if (stage.id === "minor" && key.mode === "minor") {
    for (let i = 0; i < scale.length - 1; i++) {
      if (scale[i] % 12 === (key.tonic + 10) % 12 && scale[i + 1] % 12 === key.tonic) cadences.push([scale[i], scale[i + 1]]);
    }
  }
  const endings = Array.from({ length: scale.length - span }, (_, i) => i)
    .filter((i) => cadences.some(([leading, tonic]) => scale[i] <= leading && tonic <= scale[i + span]));
  if (!shift && cadences.length && bar % 2 && (previous === null || !endings.includes(previous))) shift = true;
  let anchor: number | null = null;
  let low = previous;
  if (shift) {
    let windows = new Map<number, number[]>();
    scale.forEach((pitch, pitchIndex) => {
      let choices = Array.from({ length: scale.length - span }, (_, i) => i).filter((i) => i <= pitchIndex && pitchIndex <= i + span);
      if (["fourths", "fifths"].includes(stage.id)) choices = choices.filter((i) => Math.max(pitchIndex - i, i + span - pitchIndex) >= stage.step);
      if (cadences.length) choices = choices.filter((i) => bar % 2 ? endings.includes(i)
        : endings.some((ending) => 0 < Math.abs(i - ending) && Math.abs(i - ending) <= stage.shift));
      if (previous !== null) choices = choices.filter((i) => i !== previous && Math.abs(i - previous) <= stage.shift);
      if (choices.length) windows.set(pitch, choices);
    });
    if (!windows.size) throw new Error("The reading stage has no playable hand position");
    windows = variedOptions(windows, history);
    const pitches = [...windows.keys()];
    anchor = rng.choices(pitches, pitches.map((pitch) => pitchNeed(hands[staff], pitch, true)))[0];
    low = rng.choice(windows.get(anchor)!);
  }
  if (low === null) throw new Error("A stationary hand needs a position");
  const pool = scale.slice(low, low + span + 1);
  const groups = beatGroups(meter);
  const starts = beatStarts(groups);
  const ending = new Map<number, number>();
  if (cadences.length && bar % 2) {
    const [leading, tonic] = rng.choice(cadences.filter(([first, last]) => pool[0] <= first && last <= pool.at(-1)!));
    ending.set(starts.at(-3)!, leading + 1);
    ending.set(starts.at(-2)!, tonic);
  }
  const options = restPositions(style, meter, ending.size);
  const rest = options.length && rng.random() < stage.rest_probability ? rng.choice(options) : null;
  figure &&= melody;
  accidental &&= melody;
  let rhythms = barRhythms(style, meter, rest, ending.size, figure);
  if (!rhythms.length && rest !== null) rhythms = barRhythms(style, meter, null, ending.size, figure);
  if (!rhythms.length) throw new Error(`No ${style} rhythm with its figure fits a bar of ${meter}`);
  const finger = stage.fingering && anchor !== null ? staff === "treble" ? pool.indexOf(anchor) + 1 : pool.length - pool.indexOf(anchor) : null;
  const cue = anchor !== null ? { staff, low: pool[0], note: null } : null;
  return { staff, melody, scale, pool, anchor, rhythms, endings: ending, cue, finger, history, starts, accidental,
    introduced: false, altered: false, chorded: false, prefix: [], cursor: 0, pitches: [] };
}
