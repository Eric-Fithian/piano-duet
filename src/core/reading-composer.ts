import { writeBar } from "./reading-bar.ts";
import type { AttackStage } from "./reading-bar.ts";
import type { PhraseWriter } from "./reading-chord.ts";
import { chooseContext } from "./reading-context.ts";
import type { ContextProgress, ContextStage, RandomChoice } from "./reading-context.ts";
import { planLine } from "./reading-line.ts";
import type { LineRandom, LineStage, ReadingHand, ReadingLine, ReadingNote } from "./reading-line.ts";
import type { MusicalKey } from "./musical-key.ts";
import { roundEven } from "./numeric.ts";
import { planScore } from "./reading-plan.ts";
import type { PlanRandom, PlanStage } from "./reading-plan.ts";
import { staffStep } from "./reading-score.ts";

export interface ComposerStage extends ContextStage, PlanStage, LineStage, AttackStage {
  number: number;
  label: string;
  description: string;
  lesson: string;
  phase: string;
  tempo: number;
  bass_low: number;
  register: number;
  rhythm_required: boolean;
  rhythm_scope: string;
  required_scores: number;
}
export interface ComposerProgress extends ContextProgress {
  hands: Record<string, ReadingHand>;
  curriculum: ContextProgress["curriculum"] & { target: string; recent_rhythms: number[][][] };
}
export type ComposerRandom = RandomChoice & PlanRandom & LineRandom;
export type PhraseFactory = (context: unknown) => PhraseWriter | Promise<PhraseWriter>;

export interface ReadingPosition { index: number; low: number; finger: number | null; clef: string; hand: string }
export interface ReadingScore {
  target: ReadingNote[];
  title: string;
  summary: string;
  instruction: string;
  bpm: number;
  meter: string;
  key: MusicalKey;
  challenge: number;
  reason: string;
  lesson: string;
  reading: {
    stage_id: string; stage_number: number; focus: string; label: string; clef: string; hand: string;
    segments: number[]; positions: ReadingPosition[]; bars_per_row: number; vocabulary: number[];
    max_step: number; introduce: null; bars: number; rhythm_required: boolean; minimum_bpm: number;
    composition: { method: string };
  };
}

export async function composeReading(stage: ComposerStage, progress: ComposerProgress, rng: ComposerRandom,
  phraseFactory: PhraseFactory, context: unknown = null, stageCount = 24): Promise<ReadingScore> {
  if (stage.id !== progress.curriculum.target) throw new Error(`Stage ${stage.id} is not the curriculum target`);
  const [clef, key, meter] = chooseContext(stage, progress, rng);
  for (let attempt = 0; attempt < 100; attempt++) {
    const phrase = await phraseFactory(context);
    const { score, lines } = await writeScore(stage, progress, clef, key, meter, rng, phrase, stageCount);
    if (varied(stage, score, lines, progress.curriculum.recent_rhythms)) return score;
  }
  throw new Error(`Aria could not write a varied ${stage.label} score`);
}

async function writeScore(stage: ComposerStage, progress: ComposerProgress, clef: string, key: MusicalKey,
  meter: string, rng: ComposerRandom, phrase: PhraseWriter, stageCount: number): Promise<{ score: ReadingScore; lines: ReadingLine[] }> {
  const [numerator, denominator] = meter.split("/").map(Number);
  const beats = numerator * 4 / denominator;
  const bpm = Math.max(60, stage.tempo + 12);
  const unit = 60 / bpm;
  const active = clef === "grand" ? ["bass", "treble"] : [clef];
  const scales: Record<string, number[]> = {};
  const windows: Record<string, number | null> = Object.fromEntries(active.map((staff) => [staff, null]));
  const histories: Record<string, number[]> = Object.fromEntries(active.map((staff) => [staff, []]));
  for (const staff of active) {
    const [low, high] = staff === "treble" ? [60, 76 + stage.register * 12] : [stage.bass_low - stage.register * 12, 59];
    scales[staff] = Array.from({ length: high - low + 1 }, (_, index) => low + index).filter((pitch) => key.pitch_classes.includes(pitch % 12));
  }
  const { shifts, figured, altered } = planScore(stage, active, meter, rng);
  const notes: ReadingNote[] = [];
  const cues: NonNullable<ReadingLine["cue"]>[] = [];
  const lines: ReadingLine[] = [];
  for (let bar = 0; bar < stage.bars; bar++) {
    const barLines: ReadingLine[] = [];
    for (const staff of active) {
      if (stage.texture === "alternating" && staff !== (bar % 2 === 0 ? "treble" : "bass")) continue;
      const line = planLine(stage, progress.hands, key, meter, clef, staff, bar, scales[staff], windows[staff], histories[staff], rng,
        windows[staff] === null || shifts[staff].has(bar), figured.has(bar), altered.has(bar));
      windows[staff] = line.scale.indexOf(line.pool[0]);
      barLines.push(line);
    }
    await writeBar(stage, progress.hands, key, bar, beats, unit, barLines, phrase, notes, rng);
    cues.push(...barLines.flatMap((line) => line.cue ? [line.cue] : []));
    lines.push(...barLines);
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const positions = cues.map((cue) => {
    if (!cue.note) throw new Error("A hand-position cue has no note");
    const index = notes.indexOf(cue.note);
    if (index < 0) throw new Error("A hand-position cue is missing from the score");
    return { index, low: staffStep(cue.low, key), finger: cue.note.finger ?? null, clef: cue.staff,
      hand: cue.staff === "bass" ? "left" : "right" };
  });
  const score: ReadingScore = {
    target: notes, title: stage.label, summary: stage.description,
    instruction: stage.description + (stage.rhythm_required ? " Keep the written rhythm; start at a comfortable steady pace." : " Play at your own pace."),
    bpm, meter, key, challenge: Math.min(5, 1 + Math.floor((stage.number - 1) / 5)),
    reason: `Stage ${stage.number} of ${stageCount} · ${stage.phase}. New music, with extra attention to your less practiced notes.`,
    lesson: `${key.name} · ${meter}. ${stage.lesson}`,
    reading: { stage_id: stage.id, stage_number: stage.number, focus: "shifts", label: stage.label, clef,
      hand: clef === "grand" ? "both" : clef === "bass" ? "left" : "right", segments: positions.map((position) => position.index),
      positions, bars_per_row: 2, vocabulary: [...new Set(Object.values(scales).flat())].sort((a, b) => a - b),
      max_step: stage.step, introduce: null, bars: stage.bars, rhythm_required: stage.rhythm_required,
      minimum_bpm: stage.tempo, composition: { method: "aria" } },
  };
  return { score, lines };
}

function varied(stage: ComposerStage, score: ReadingScore, lines: ReadingLine[], recent: number[][][]): boolean {
  for (const staff of new Set(lines.map((line) => line.staff))) {
    const melody = lines.filter((line) => line.staff === staff).flatMap((line) => line.pitches);
    if (melody.length >= 6 && new Set(melody).size < 3) return false;
  }
  if (stage.rhythm !== "long") return true;
  const pattern = score.target.map((note) => [roundEven(note.start * score.bpm / 60 * 1e4) / 1e4,
    roundEven(note.duration * score.bpm / 60 * 1e4) / 1e4]);
  const intervals = lines.reduce((sum, line) => sum + line.pitches.length - 1, 0);
  return !recent.some((item) => JSON.stringify(item) === JSON.stringify(pattern)) && intervals >= 2 && new Set(pattern.map(([, duration]) => duration)).size >= 2;
}
