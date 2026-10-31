import { DRILL_CATALOG } from "./drill-catalog.ts";

export type DrillId = keyof typeof DRILL_CATALOG.drills;
export type DrillLevelEntry = {
  config: { drill: DrillId; variant: string; tonic: number; hands: string };
  best: number | null;
  last: number;
};

const LEVEL_KEYS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20];
const TOGETHER = ["together", "contrary", "third", "sixth"];

export function drillLevels(progress: Record<string, DrillLevelEntry>) {
  return Object.fromEntries(Object.entries(DRILL_CATALOG.drills).map(([drill, spec]) => {
    const entries = Object.values(progress).filter((entry) => entry.config.drill === drill);
    const ladder: readonly { per_beat: number; bpm: number }[] = spec.ladder;
    const start = ladder[spec.start];
    const firstRate = start.per_beat * start.bpm;
    const top = ladder.at(-1)!;
    const span = top.per_beat * top.bpm - firstRate;
    const share = (rung: number) => {
      const tempo = ladder[rung];
      if (!tempo) throw new Error(`Invalid rung ${rung} for ${drill}`);
      return Math.min(1, (tempo.per_beat * tempo.bpm - firstRate) / span);
    };
    const together = spec.hands.some((hand) => TOGETHER.includes(hand));
    let level = 0;
    let next: { level: number; keys: number; done: number; tempo: { per_beat: number; bpm: number }; rung: number; hands_together: boolean } | null = null;
    for (let index = 0; index < LEVEL_KEYS.length; index++) {
      const number = index + 1;
      const threshold = index / 9;
      const hands = number >= 4 && together;
      const qualified = new Set(entries.filter((entry) => entry.best !== null && share(entry.best) >= threshold - 1e-9
        && (!hands || TOGETHER.includes(entry.config.hands))).map((entry) => JSON.stringify([entry.config.variant, entry.config.tonic])));
      const needed = Math.min(LEVEL_KEYS[index], 12 * spec.variants.length);
      if (qualified.size < needed) {
        const rung = ladder.findIndex((_, candidate) => share(candidate) >= threshold - 1e-9);
        if (rung < 0) throw new Error(`No tempo reaches level ${number} for ${drill}`);
        next = { level: number, keys: needed, done: qualified.size, tempo: { ...ladder[rung] }, rung, hands_together: hands };
        break;
      }
      level = number;
    }
    const last = entries.length ? Math.max(...entries.map((entry) => entry.last)) : null;
    return [drill, { level, next, last, name: spec.name, group: spec.group }];
  }));
}
