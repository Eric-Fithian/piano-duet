import { assessDrill } from "./drill-assessment.ts";
import type { DrillConfig, DrillPrompt } from "./drill-assessment.ts";
import { DRILL_CATALOG, DRILL_MILESTONES } from "./drill-catalog.ts";
import type { DrillId } from "./drill-levels.ts";
import type { DrillNote } from "./drill-timing.ts";

export type DrillAttempt = { mode: string; excluded: boolean; context: { source: string }; notes: DrillNote[];
  prompt: DrillPrompt; recognition: { usable: boolean; [key: string]: unknown }; created_at: number };
type WorkingEntry = { config: DrillConfig; title: string; group: string; working: number; best: number | null;
  attempts: number; clean: number; run: number[]; misses: number; last: number };
type Verdict = { usable: boolean; clean: boolean; credit: number | null };

export function drillMilestone(drill: DrillId, rung: number) {
  const tempo = DRILL_CATALOG.drills[drill].ladder[rung];
  if (!tempo) throw new Error(`Invalid rung ${rung} for ${drill}`);
  const rate = tempo.per_beat * tempo.bpm;
  const milestones: readonly (readonly [number, number, string])[] = DRILL_MILESTONES[drill];
  const reached = milestones.filter(([perBeat, bpm]) => rate >= perBeat * bpm);
  const upcoming = milestones.find(([perBeat, bpm]) => rate < perBeat * bpm);
  return { reached: reached.at(-1)?.[2] ?? null, next: upcoming ? { label: upcoming[2], per_beat: upcoming[0], bpm: upcoming[1] } : null };
}

export function drillProgress(attempts: DrillAttempt[]) {
  const progress: Record<string, WorkingEntry> = {}, days = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.mode !== "drills" || attempt.excluded || attempt.context.source !== "microphone" || !attempt.notes.length) continue;
    const prompt = attempt.prompt, drill = prompt.drill, spec = DRILL_CATALOG.drills[drill.drill];
    const result = assessDrill(prompt, attempt.notes, attempt.context, attempt.recognition).drill as Verdict | null;
    if (!result) throw new Error("A nonempty drill take has no verdict");
    const config = { drill: drill.drill, variant: drill.variant, tonic: drill.tonic, hands: drill.hands, octaves: drill.octaves, inversion: drill.inversion };
    const entry = progress[drill.config_key] ??= { config, title: drill.title, group: spec.group, working: spec.start,
      best: null, attempts: 0, clean: 0, run: [], misses: 0, last: attempt.created_at };
    entry.attempts++; entry.last = attempt.created_at; days.add(localDate(attempt.created_at));
    if (drill.practice !== "even" || !result.usable) continue;
    const top = spec.ladder.length - 1;
    if (result.clean) {
      if (result.credit === null) throw new Error("A clean take has no credited tempo");
      entry.clean++; entry.misses = 0; entry.run.push(result.credit);
      if (entry.run.length === 3) {
        const earned = Math.min(...entry.run);
        entry.best = entry.best === null ? earned : Math.max(entry.best, earned);
        entry.working = Math.max(entry.working, Math.min(top, earned + 1)); entry.run = [];
      }
    } else {
      entry.run = []; entry.misses++;
      if (entry.misses === 2) { entry.working = Math.max(0, entry.working - 1); entry.misses = 0; }
    }
  }
  const finalized = Object.fromEntries(Object.entries(progress).map(([key, entry]) => {
    const { run, ...rest } = entry, ladder = DRILL_CATALOG.drills[entry.config.drill].ladder;
    return [key, { ...rest, streak: run.length, working_tempo: { ...ladder[entry.working] },
      best_tempo: entry.best === null ? null : { ...ladder[entry.best] }, goal: entry.best === ladder.length - 1,
      milestone: entry.best === null ? null : drillMilestone(entry.config.drill, entry.best).reached }];
  }));
  return { progress: finalized, practice_days: days.size };
}

function localDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.valueOf())) throw new Error("Invalid attempt time");
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
