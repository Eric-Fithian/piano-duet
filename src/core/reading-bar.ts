import { chromaticOptions, degree, introducing, noteWeight, remainingAttacks, remainingBeats } from "./reading-choices.ts";
import { buildChord } from "./reading-chord.ts";
import type { ChordRandom, PhraseWriter } from "./reading-chord.ts";
import { variedOptions } from "./reading-line.ts";
import type { ReadingHand, ReadingLine, ReadingNote } from "./reading-line.ts";
import type { MusicalKey } from "./musical-key.ts";
import { roundEven } from "./numeric.ts";
import { nextValues } from "./reading-rhythm.ts";

const EPSILON = 1e-9;
const CHORDS: Record<string, number[][]> = {
  dyads: [[0, 2], [0, 4]],
  triads: [[0, 2, 4], [0, 2, 5], [0, 3, 5]],
  independent: [[0, 2, 4], [0, 2, 5], [0, 3, 5]],
  voicings: [[0, 7], [0, 2, 4], [0, 2, 5], [0, 3, 5], [0, 2, 4, 6]],
};
export interface AttackStage { id: string; texture: string; step: number; chromatic: number }

export async function writeBar(stage: AttackStage, hands: Record<string, ReadingHand>, key: MusicalKey,
  bar: number, beats: number, unit: number, lines: ReadingLine[], phrase: PhraseWriter,
  notes: ReadingNote[], rng: ChordRandom): Promise<void> {
  while (true) {
    const waiting = lines.filter((line) => line.cursor < beats - EPSILON)
      .sort((a, b) => roundEven(a.cursor * 1e6) - roundEven(b.cursor * 1e6) || Number(a.staff !== "bass") - Number(b.staff !== "bass"));
    if (!waiting.length) return;
    const line = waiting[0];
    const values = nextValues(line.rhythms, line.prefix);
    if (!values.length) throw new Error("No rhythm continues the current bar");
    if (values[0] < 0) {
      if (values.length > 1) throw new Error("A rest cannot share its position with a note");
      line.prefix.push(values[0]);
      line.cursor -= values[0];
    } else await writeAttack(stage, hands, key, bar, beats, unit, line, values, phrase, notes, rng);
  }
}

export async function writeAttack(stage: AttackStage, hands: Record<string, ReadingHand>, key: MusicalKey,
  bar: number, beats: number, unit: number, line: ReadingLine, values: number[], phrase: PhraseWriter,
  notes: ReadingNote[], rng: ChordRandom): Promise<void> {
  const { scale, pool } = line;
  const hand = hands[line.staff];
  const index = line.pitches.length;
  const onset = (bar * beats + line.cursor) * unit;
  const onBeat = line.starts.slice(0, -1).some((start) => Math.abs(line.cursor - start) < EPSILON);
  const shapes = line.melody && onBeat ? CHORDS[stage.texture] ?? [] : [];
  const forced = shapes.length > 0 && !line.chorded && remainingBeats(line) === 0;
  const fixed = [...line.endings].find(([start]) => Math.abs(start - line.cursor) < EPSILON)?.[1];
  const room = forced ? Math.min(...shapes.map((shape) => Math.max(...shape))) : 0;
  let lowest: Map<number, number>;
  if (index === 0 && line.anchor !== null) lowest = new Map([[line.anchor, 1]]);
  else if (fixed !== undefined) lowest = new Map([[fixed, 1]]);
  else {
    const previous = line.history.at(-1);
    if (previous === undefined) throw new Error("A reading line needs a previous pitch");
    let choices = pool.filter((pitch) => Math.abs(degree(scale, pitch) - degree(scale, previous)) <= stage.step);
    if (["fourths", "fifths"].includes(stage.id) && !line.introduced) {
      choices = introducing(stage.step, pool, scale, index ? previous : null, choices, remainingAttacks(line));
    }
    lowest = new Map();
    for (let pitch of choices) {
      pitch = scale[Math.min(scale.indexOf(pitch), scale.length - 1 - room)];
      lowest.set(pitch, Math.max(noteWeight(hand, previous, pitch), lowest.get(pitch) ?? 0));
    }
    if (!forced) for (const [pitch, weight] of chromaticOptions(stage, key, line, lowest, hand, previous)) lowest.set(pitch, weight);
    lowest = variedOptions(lowest, line.history);
    const due = remainingAttacks(line) <= (CHORDS[stage.texture] && line.melody ? 1 : 0);
    if (line.accidental && !line.altered && due && !forced) {
      const chromatic = new Map([...lowest].filter(([pitch]) => !key.pitch_classes.includes(pitch % 12)));
      if (chromatic.size) lowest = chromatic;
    }
  }
  const durations = new Map(values.map((value) => [value * unit, value]));
  const [pitch, seconds] = await phrase.note(onset, lowest, new Map([...durations.keys()].map((seconds) => [seconds, 1])));
  const value = durations.get(seconds);
  if (value === undefined) throw new Error("Phrase selected an unavailable duration");
  const chord = await buildChord(stage.texture, scale, pitch, onset, seconds, shapes, forced, phrase, rng);
  for (const p of chord) {
    const note: ReadingNote = { pitch: p, start: roundEven(onset * 1e6) / 1e6,
      duration: roundEven(value * unit * 1e6) / 1e6, velocity: 76, staff: line.staff };
    if (index === 0 && line.finger !== null) note.finger = line.finger;
    if (line.cue && line.cue.note === null) line.cue.note = note;
    notes.push(note);
  }
  if (index) line.introduced ||= Math.abs(degree(scale, pitch) - degree(scale, line.pitches.at(-1)!)) === stage.step;
  line.altered ||= !key.pitch_classes.includes(pitch % 12);
  line.chorded ||= chord.length > 1;
  line.pitches.push(pitch);
  line.history.push(pitch);
  line.prefix.push(value);
  line.cursor += value;
}
