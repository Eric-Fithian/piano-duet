import { curriculumProgress } from "./reading-curriculum.ts";
import type { CurriculumAttempt } from "./reading-curriculum.ts";
import { readingRows, summarizeReading } from "./reading-evidence.ts";
import type { ReadingSample } from "./reading-evidence.ts";
import { measureLandings, summarizeFluency } from "./reading-fluency.ts";
import type { LandingChange, PositionChange } from "./reading-fluency.ts";
import { mean, roundEven } from "./numeric.ts";
import { levelProgress, scoreXp, stageClearXp } from "./reading-rewards.ts";

const VOCABULARIES: Record<string, number[]> = {
  treble: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76],
  bass: [48, 50, 52, 53, 55, 57, 59],
};
const SKILLS = [
  ["starts", "Find your starting note", "Find a note on the keyboard without a preceding note to guide you."],
  ["patterns", "Read steps and skips", "Follow the movement between notes in a fresh phrase."],
  ["shifts", "Move between positions", "Find a fresh starting point at the next bar, then continue reading."],
] as const;

export interface ProgressAttempt extends CurriculumAttempt {
  id: number | string;
  created_at: number | string;
  context: CurriculumAttempt["context"] & { hearings: number; reveals: number; hints: number; interaction?: string; introduction?: boolean; familiar?: boolean };
  prompt: CurriculumAttempt["prompt"] & {
    target: (CurriculumAttempt["prompt"]["target"][number] & { staff?: string | null })[];
    reading: CurriculumAttempt["prompt"]["reading"] & { segments?: number[]; stage_number?: number; introduce?: number | null; rhythm_required?: boolean };
  };
  assessment: CurriculumAttempt["assessment"] & {
    score: { first_try: number; total: number }; fluency?: PositionChange[]; rhythm?: { accuracy: number | null };
  };
}

export function readingProgress(attempts: ProgressAttempt[]) {
  const rows: ReadingSample[] = [];
  const changes: LandingChange[] = [];
  const rounds: { id: number | string; accuracy: number; rhythm: number | null; xp: number; stage: number; at: number | string }[] = [];
  const scoreXps = new Map<number | string, number>();
  const introduced: Record<string, Set<number>> = Object.fromEntries(Object.keys(VOCABULARIES).map((clef) => [clef, new Set()]));
  for (const attempt of attempts) {
    if (attempt.excluded || attempt.context.source !== "microphone" || attempt.prompt.family !== "reading") continue;
    const { prompt, assessment, context } = attempt;
    if (context.interaction === "step_by_step") scoreXps.set(attempt.id, scoreXp(prompt, assessment, context).total);
    changes.push(...measureLandings(assessment.fluency ?? [], assessment.observations, context));
    const introduction = context.familiar ? null : prompt.reading?.introduce;
    if (introduction != null) {
      const hand = introduced[prompt.reading.clef];
      if (!hand) throw new Error(`Unknown introduction clef ${prompt.reading.clef}`);
      hand.add(introduction);
    }
    if (!assessment.evidence.some((item) => item.skill === "reading.pitch")) continue;
    const current = readingRows(prompt, assessment.observations).map((row) => ({ ...row, attempt: attempt.id }));
    rows.push(...current);
    rounds.push({ id: attempt.id, accuracy: roundEven(100 * mean(current.map((row) => row.value))),
      rhythm: assessment.rhythm?.accuracy ?? null, xp: scoreXps.get(attempt.id) ?? 0,
      stage: prompt.reading?.stage_number ?? 1, at: attempt.created_at });
  }
  const hands = Object.fromEntries(Object.entries(VOCABULARIES).map(([clef, vocabulary]) => {
    const handRows = rows.filter((row) => row.clef === clef);
    const pitches = [...new Set([...vocabulary, ...handRows.map((row) => row.pitch)])].sort((a, b) => a - b);
    const byPitch = Object.fromEntries(pitches.map((pitch) => [String(pitch), summarizeReading(handRows.filter((row) => row.pitch === pitch))]));
    const starts = Object.fromEntries(pitches.map((pitch) => [String(pitch), summarizeReading(handRows.filter((row) => row.pitch === pitch && ["starts", "shifts"].includes(row.kind)))]));
    let size = 3;
    while (size < vocabulary.length && vocabulary.slice(0, size).every((pitch) => byPitch[String(pitch)].samples >= 3 && byPitch[String(pitch)].accuracy! >= 85)) size++;
    const movements = [...new Set(handRows.flatMap((row) => row.interval === null ? [] : [row.interval]))];
    return [clef, { samples: handRows.length, vocabulary: vocabulary.slice(0, size), pitches: byPitch, starting_pitches: starts,
      introduced: [...introduced[clef]].sort((a, b) => a - b), fluency: summarizeFluency(changes.filter((change) => change.clef === clef)),
      movements: Object.fromEntries(movements.map((interval) => [String(interval), summarizeReading(handRows.filter((row) => row.interval === interval))])),
      starts: summarizeReading(handRows.filter((row) => row.kind === "starts")),
      patterns: summarizeReading(handRows.filter((row) => row.kind === "patterns")),
      shifts: summarizeReading(handRows.filter((row) => row.kind === "shifts")) }];
  }));
  const skills = SKILLS.map(([kind, label, description]) => ({ id: kind, label, description,
    ...summarizeReading(rows.filter((row) => row.kind === kind)),
    hands: Object.fromEntries(Object.keys(hands).map((clef) => [clef, hands[clef][kind]])),
    ready: Object.keys(hands).every((clef) => hands[clef][kind].ready),
  }));
  const recent = rows.slice(-32), earlier = rows.slice(-64, -32);
  const change = earlier.length >= 16 ? roundEven(100 * (mean(recent.map((row) => row.value)) - mean(earlier.map((row) => row.value)))) : null;
  const curriculum = curriculumProgress(attempts);
  const cleared = curriculum.path.filter((stage) => stage.status === "Complete").reduce((sum, stage) => sum + stageClearXp(stage.number), 0);
  return { curriculum, xp: levelProgress([...scoreXps.values()].reduce((sum, xp) => sum + xp, 0) + cleared), hands, skills,
    rounds: rounds.length, notes: rows.length, accuracy: recent.length ? roundEven(100 * mean(recent.map((row) => row.value))) : null,
    change, history: rounds.slice(-12), current: skills.find((skill) => !skill.ready)?.id ?? "shifts",
    introductions: Object.values(introduced).reduce((sum, pitches) => sum + pitches.size, 0) };
}
