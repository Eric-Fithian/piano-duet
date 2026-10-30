import { figures } from "./reading-rhythm.ts";

export interface PlanStage {
  bars: number;
  texture: string;
  rhythm: string;
  chromatic: number;
}
export interface PlanRandom {
  choice<T>(options: T[]): T;
  random(): number;
  sample(options: number[], count: number): number[];
}
export interface ScorePlan {
  shifts: Record<string, Set<number>>;
  figured: Set<number>;
  altered: Set<number>;
}

export function planScore(stage: PlanStage, active: string[], meter: string, rng: PlanRandom): ScorePlan {
  const plays: Record<string, number[]> = {};
  for (const staff of active) {
    plays[staff] = Array.from({ length: stage.bars }, (_, bar) => bar)
      .filter((bar) => stage.texture !== "alternating" || staff === (bar % 2 === 0 ? "treble" : "bass"));
  }
  const shifts: Record<string, Set<number>> = {};
  for (const staff of active) {
    const later = plays[staff].slice(1);
    const required = later.length ? [rng.choice(later)] : [];
    shifts[staff] = new Set([...required, ...later.filter(() => rng.random() < 1 / 3)]);
  }
  const melody = [...new Set(active.flatMap((staff) => plays[staff].filter(() => staff === "treble" || active.length === 1)))].sort((a, b) => a - b);
  const styled = !["quarters", "long"].includes(stage.rhythm) && figures(stage.rhythm, meter).some((figure) => figure.length > 0);
  const figured = new Set(styled ? rng.sample(melody, Math.min(2, melody.length)) : []);
  const altered = new Set(stage.chromatic >= 2 ? rng.sample(melody, Math.min(rng.choice([1, 2]), melody.length)) : []);
  return { shifts, figured, altered };
}
