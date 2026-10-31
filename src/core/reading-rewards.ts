import { roundEven } from "./numeric.ts";

export interface ReadingPrompt {
  reading?: {
    stage_number?: number;
    introduce?: number | null;
    rhythm_required?: boolean;
  };
}

export interface ReadingAssessment {
  score: { first_try: number; total: number };
  observations: { index: number; group?: number; matched: boolean }[];
  rhythm?: { accuracy: number | null };
}

export interface ReadingContext {
  hearings: number;
  reveals: number;
  hints: number;
  familiar?: boolean;
}

export interface RewardItem {
  id: string;
  label: string;
  count?: number;
  xp: number;
}

export function noteValue(stageNumber: number): number {
  return 10 + 2 * (stageNumber - 1);
}

export function longestStreak(observations: ReadingAssessment["observations"]): number {
  let best = 0;
  let run = 0;
  let group: number | undefined;
  let clean = true;
  for (const row of observations) {
    const next = row.group ?? row.index;
    if (group !== undefined && group !== next) {
      run = clean ? run + 1 : 0;
      best = Math.max(best, run);
      clean = true;
    }
    group = next;
    clean &&= row.matched;
  }
  if (group !== undefined && clean) best = Math.max(best, run + 1);
  return best;
}

export function scoreXp(
  prompt: ReadingPrompt,
  assessment: ReadingAssessment,
  context: ReadingContext,
): { items: RewardItem[]; total: number } {
  if (context.familiar) return { items: [], total: 0 };
  const reading = prompt.reading ?? {};
  const value = noteValue(reading.stage_number ?? 1);
  if (reading.introduce != null) {
    const item = { id: "introduction", label: "New note", xp: 3 * value };
    return { items: [item], total: item.xp };
  }
  const { first_try: firstTry, total } = assessment.score;
  const notesXp = firstTry * value;
  const items: RewardItem[] = [
    { id: "first_try", label: "First-try notes", count: firstTry, xp: notesXp },
    { id: "recovered", label: "Recovered notes", count: total - firstTry, xp: (total - firstTry) * Math.floor(value / 4) },
  ];
  const streak = longestStreak(assessment.observations);
  if (streak >= 4) {
    items.push({ id: "streak", label: "Best streak", count: streak, xp: streak * Math.floor(value / 2) });
  }
  const rhythm = assessment.rhythm?.accuracy;
  if (reading.rhythm_required && rhythm != null) {
    items.push({ id: "rhythm", label: "On the beat", count: rhythm, xp: roundEven(notesXp * rhythm / 200) });
  }
  if (total && firstTry === total) {
    items.push({ id: "perfect", label: "Perfect read", xp: roundEven(notesXp / 2) });
  }
  const earned = items.filter((item) => item.xp > 0);
  const subtotal = earned.reduce((sum, item) => sum + item.xp, 0);
  if (context.hearings || context.reveals || context.hints) {
    earned.push({ id: "assisted", label: "Assisted", xp: 0 - Math.floor(subtotal / 2) });
  }
  return { items: earned, total: earned.reduce((sum, item) => sum + item.xp, 0) };
}

export function stageClearXp(stageNumber: number): number {
  return 300 + 100 * (stageNumber - 1);
}

export function levelProgress(xp: number): { xp: number; level: number; into: number; needed: number } {
  let level = 1;
  let floor = 0;
  while (xp >= floor + 400 + 100 * (level - 1)) {
    floor += 400 + 100 * (level - 1);
    level++;
  }
  return { xp, level, into: xp - floor, needed: 400 + 100 * (level - 1) };
}
