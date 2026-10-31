import { variedOptions } from "./reading-line.ts";
import type { ReadingNote } from "./reading-line.ts";
import type { PhraseFactory, ReadingPosition } from "./reading-composer.ts";
import type { readingProgress } from "./reading-progress.ts";

type Progress = ReturnType<typeof readingProgress>;
type Hand = Progress["hands"][string];
export interface FoundationRandom {
  random(): number;
  choice<T>(options: T[]): T;
  choices<T extends number | [number, number]>(options: T[], weights: number[]): T[];
  randrange(start: number, stop: number): number;
}
export interface FoundationCandidate {
  target: ReadingNote[]; title: string; summary: string; instruction: string; bpm: number; challenge: number; reason: string; lesson: string;
  reading: { stage_id: string; stage_number: number; focus: "starts" | "patterns" | "shifts"; label: string; clef: string; hand: string;
    segments: number[]; bars_per_row: number; bars: number; positions: ReadingPosition[]; vocabulary: number[]; max_step: number;
    introduce: number | null; composition?: { method: string } };
}
const WHITE_KEYS = Array.from({ length: 88 }, (_, index) => index + 21).filter((pitch) => [0, 2, 4, 5, 7, 9, 11].includes(pitch % 12));
const LABELS = { starts: "Find your starting note", patterns: "Read steps and skips", shifts: "Move between positions" };

function whiteIndex(pitch: number): number {
  const index = WHITE_KEYS.indexOf(pitch);
  if (index < 0) throw new Error(`Pitch ${pitch} is not a white piano key`);
  return index;
}
function whiteName(pitch: number): string {
  const names: Record<number, string> = { 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" };
  if (!names[pitch % 12]) throw new Error(`Pitch ${pitch} is not a white piano key`);
  return names[pitch % 12] + (Math.floor(pitch / 12) - 1);
}
function positionChoices(pitches: number[], previous: number | null): number[] {
  const indices = pitches.map(whiteIndex);
  if (!indices.length) throw new Error("A hand position needs pitches");
  const low = Math.max(0, Math.max(...indices) - 4), high = Math.min(...indices);
  let choices = Array.from({ length: Math.max(0, high - low + 1) }, (_, index) => index + low);
  if (previous !== null && choices.includes(previous) && choices.length > 1) choices = choices.filter((value) => value !== previous);
  return choices;
}
function choosePitch(pitches: number[], stats: Hand["pitches"], rng: FoundationRandom): number {
  return rng.choices(pitches, pitches.map((pitch) => 1 + (100 - (stats[String(pitch)].accuracy ?? 0)) / 20 + 3 / (1 + stats[String(pitch)].samples)))[0];
}
function positionChange(hand: Hand, clef: string, previous: number, rng: FoundationRandom): [number, number] {
  const fluency = hand.fluency;
  const fluent = hand.shifts.ready && fluency.samples >= 5 && fluency.extra_beats !== null && fluency.extra_beats <= 0.25;
  const needs = new Map(fluency.transitions.filter((row) => row.samples >= 3).map((row) => [JSON.stringify([row.pitch, row.finger, row.shift_steps]), row.extra_beats]));
  const choices: [number, number][] = [], weights: number[] = [];
  for (const pitch of hand.vocabulary) {
    const nearby = [...hand.vocabulary].sort((a, b) => Math.abs(whiteIndex(a) - whiteIndex(pitch)) - Math.abs(whiteIndex(b) - whiteIndex(pitch))).slice(0, 3);
    for (const low of positionChoices(nearby, previous)) {
      if (low === previous) continue;
      let finger = whiteIndex(pitch) - low + 1;
      if (clef === "bass") finger = 6 - finger;
      const shift = low - previous, stats = hand.starting_pitches[String(pitch)];
      let need = 1 + (100 - (stats.accuracy ?? 0)) / 20 + 3 / (1 + stats.samples);
      need *= 1 + Math.min(3, needs.get(JSON.stringify([pitch, finger, shift])) ?? 0);
      need *= fluent ? 1 + Math.min(5, Math.abs(shift)) / 5 : 1 / (1 + Math.abs(shift));
      choices.push([pitch, low]); weights.push(need);
    }
  }
  if (!choices.length) throw new Error("The reading vocabulary has no playable position change");
  return rng.choices(choices, weights)[0];
}

export async function readingFoundation(progress: Progress, rng: FoundationRandom, phrase: PhraseFactory,
  previous: FoundationCandidate | null = null, variation = 0, repair = false, teach = false, context: unknown = null): Promise<FoundationCandidate> {
  const hands = progress.hands;
  let clef = Object.keys(hands).sort((a, b) => hands[a].samples - hands[b].samples || Number(a === "bass") - Number(b === "bass"))[0];
  const weak = Object.keys(hands).filter((name) => {
    const hand = hands[name];
    return [hand.starts, hand.patterns].some((skill) => skill.accuracy !== null && skill.accuracy < 70)
      || hand.fluency.transitions.some((row) => row.samples >= 3 && row.extra_beats > 0.5);
  });
  if (weak.length && (repair || rng.random() < 0.65)) clef = rng.choice(weak);
  let hand = hands[clef];
  let vocabulary = hand.vocabulary;
  if (progress.curriculum.target_number === 1) { vocabulary = vocabulary.slice(0, 3); hand = { ...hand, vocabulary }; }
  const startsReady = hand.starts.ready, patternsReady = hand.patterns.ready;
  let focus: "starts" | "patterns" | "shifts" = startsReady && patternsReady && rng.random() < 0.5 ? "shifts"
    : !startsReady || rng.random() < 0.3 ? "starts" : "patterns";
  let priority = choosePitch(vocabulary, focus === "starts" ? hand.starting_pitches : hand.pitches, rng);
  const introduction = teach && variation === 0 ? vocabulary.find((pitch) => !hand.introduced.includes(pitch) && !hand.pitches[String(pitch)].samples) ?? null : null;
  const maxStep = hand.patterns.accuracy !== null && hand.patterns.accuracy >= 85 && hand.patterns.samples >= 6 ? 2 : 1;
  let length = 4;
  if (introduction !== null) { priority = introduction; length = 1; focus = "starts"; }
  const positions: ReadingPosition[] = [], notes: ReadingNote[] = [], segments: number[] = [];
  let previousLow = previous?.reading.clef === clef ? previous.reading.positions.at(-1)?.low ?? null : null;
  const required = rng.randrange(1, 4);
  const plan: { priority: number | null; low: number }[] = [];
  for (let segment = 0; segment < 4; segment++) {
    if (segment && introduction === null && segment !== required && rng.random() >= 1 / 3) {
      if (previousLow === null) throw new Error("A stationary hand needs a previous position");
      plan.push({ priority: null, low: previousLow }); continue;
    }
    let low: number;
    if (segment && introduction === null) {
      if (previousLow === null) throw new Error("A hand shift needs a previous position");
      [priority, low] = positionChange(hand, clef, previousLow, rng);
    } else {
      const possible = introduction !== null ? [introduction] : [...vocabulary].sort((a, b) =>
        Math.abs(whiteIndex(a) - whiteIndex(priority)) - Math.abs(whiteIndex(b) - whiteIndex(priority))).slice(0, 3);
      low = rng.choice(positionChoices(possible, previousLow));
    }
    if (segment && low === plan.at(-1)!.low) throw new Error("A position change must move the hand");
    plan.push({ priority, low }); previousLow = low;
  }
  const session = introduction === null ? await phrase(context) : null;
  const melody: number[] = [];
  for (let segment = 0; segment < plan.length; segment++) {
    const { priority: anchor, low } = plan[segment];
    const pool = vocabulary.filter((pitch) => low <= whiteIndex(pitch) && whiteIndex(pitch) <= low + 4);
    const following = plan[segment + 1]?.priority ?? null, beat = segment * 4;
    if (anchor !== null) {
      if (session) await session.note(beat, new Map([[anchor, 1]]), new Map([[1, 1]]));
      melody.push(anchor);
    }
    for (let offset = anchor === null ? 0 : 1; offset < length; offset++) {
      if (!session || !melody.length) throw new Error("A melody needs a phrase and preceding note");
      const previousPitch = melody.at(-1)!;
      const options = new Map<number, number>();
      for (const pitch of pool) {
        if (Math.abs(whiteIndex(pitch) - whiteIndex(previousPitch)) > maxStep) continue;
        const movement = hand.movements[String(pitch - previousPitch)];
        if (movement && movement.accuracy === null) throw new Error("A measured movement needs accuracy");
        let need = movement ? 1 + (100 - movement.accuracy!) / 20 : 4;
        need += (100 - (hand.pitches[String(pitch)].accuracy ?? 0)) / 20;
        options.set(pitch, need * (pitch === previousPitch ? 0.35 : 1));
      }
      const avoid = offset === length - 1 && melody.at(-1) === following ? [following!] : [];
      melody.push((await session.note(beat + offset, variedOptions(options, melody, avoid), new Map([[1, 1]])))[0]);
    }
    let finger: number | null = null;
    if (anchor !== null) {
      segments.push(notes.length);
      finger = whiteIndex(anchor) - low + 1;
      if (clef === "bass") finger = 6 - finger;
      positions.push({ index: notes.length, low, finger });
    }
    melody.slice(-length).forEach((pitch, offset) => notes.push({ pitch, start: beat + offset, duration: 1, velocity: 76,
      ...(offset === 0 && finger !== null ? { finger } : {}) }));
  }
  let instruction = { starts: "Find the first note, using the suggested finger. Then read on.", patterns: "Follow the steps and skips. A step moves to a neighboring white key.",
    shifts: "Read ahead to the next bar and prepare your new hand position." }[focus] + " Move your hand when a numbered finger appears.";
  let title = { starts: "Starting notes", patterns: "Steps and skips", shifts: "Changing position" }[focus];
  if (introduction !== null) {
    const name = whiteName(introduction), bottom = clef === "treble" ? 64 : 43, distance = whiteIndex(introduction) - whiteIndex(bottom);
    const location = distance >= 0 && distance <= 8 ? `${distance % 2 === 0 ? "line" : "space"} ${Math.floor(distance / 2) + 1} from the bottom`
      : distance < 0 ? "below the staff" : "above the staff";
    instruction = `This is ${name}${introduction === 60 ? " (middle C)" : ""}, ${location}. Play it with the numbered finger in each bar. This introduction is unscored.`;
    title = `Meet ${name}`;
  }
  return { target: notes, title, summary: instruction, instruction, bpm: 60, challenge: focus === "shifts" ? 3 : maxStep === 2 ? 2 : 1,
    reason: `Practice ${clef} clef in a fresh setting. Starting notes and intervals are assessed separately; finger choice is not graded.`,
    lesson: `The first note is ${whiteName(notes[0].pitch)}. The number is a finger, not a note name: thumb 1 through little finger 5. Higher on the staff means farther right on the keyboard.`,
    reading: { stage_id: progress.curriculum.target, stage_number: progress.curriculum.target_number, focus, label: LABELS[focus], clef,
      hand: clef === "bass" ? "left" : "right", segments, bars_per_row: 2, bars: 4, positions, vocabulary, max_step: maxStep, introduce: introduction,
      ...(session ? { composition: { method: "aria" } } : {}) } };
}
