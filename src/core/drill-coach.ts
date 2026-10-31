import type { DrillConfig } from "./drill-assessment.ts";
import { DRILL_CATALOG } from "./drill-catalog.ts";
import { drillLevels } from "./drill-levels.ts";
import type { DrillId } from "./drill-levels.ts";
import type { DrillSelection } from "./drill-task.ts";

type Entry = { config: DrillConfig; best: number | null; working: number; attempts: number; last: number };
const TOGETHER = ["together", "contrary", "third", "sixth"];
const KEY_ORDER: [number, string][] = [[0, "major"], [7, "major"], [5, "major"], [9, "minor"], [2, "major"],
  [4, "minor"], [10, "major"], [2, "minor"], [9, "major"], [3, "major"]];
for (const mode of ["major", "minor"]) for (let tonic = 0; tonic < 12; tonic++) {
  if (!KEY_ORDER.some(([key, form]) => key === tonic && form === mode)) KEY_ORDER.push([tonic, mode]);
}

export function drillConfigKey(config: DrillConfig): string {
  return [config.drill, config.variant, config.tonic, config.hands, config.octaves, config.inversion].join("|");
}

export function coachDrill(progress: Record<string, Entry>, avoid: DrillId[] = [], now = Date.now() / 1000, focus: DrillId | null = null) {
  const levels = drillLevels(progress), drills = Object.keys(DRILL_CATALOG.drills) as DrillId[];
  const total = drills.reduce((sum, drill) => sum + levels[drill].level, 0);
  const tier = 1 + Number(total >= 4) + Number(total >= 10);
  const unlocked = drills.filter((drill) => DRILL_CATALOG.drills[drill].level <= tier);
  const eligible = unlocked.filter((drill) => !avoid.includes(drill));
  const pool = eligible.length ? eligible : unlocked;
  const weakness = (drill: DrillId) => {
    const last: number | null = levels[drill].last;
    const idle = last === null ? 4 : Math.min(4, (now - last) / 86400);
    return levels[drill].level - 0.25 * idle;
  };
  const drill = focus ?? pool.reduce((best, candidate) => weakness(candidate) < weakness(best) ? candidate : best);
  const spec = DRILL_CATALOG.drills[drill], level: number = levels[drill].level;
  const goal = levels[drill].next ?? { level: 10, rung: spec.ladder.length - 1, hands_together: false };
  const variantFor = (mode: string): string | null => {
    if (drill === "scale") return mode === "major" ? "major" : goal.level <= 3 ? "natural minor" : "harmonic minor";
    if (drill === "five_finger") return mode === "major" ? "major" : "natural minor";
    if (drill === "seventh_arpeggio") return mode === "major" ? "dominant 7th" : "diminished 7th";
    if (drill === "chromatic") return mode === "major" ? "chromatic" : null;
    return (spec.variants as readonly string[]).includes(mode) ? mode : null;
  };
  let hands: string;
  if (goal.hands_together) hands = TOGETHER.find((hand) => (spec.hands as readonly string[]).includes(hand))!;
  else {
    const single = ["right", "left"].filter((hand) => (spec.hands as readonly string[]).includes(hand));
    if (!single.length) single.push(spec.hands[0]);
    const practiced = (hand: string) => Object.values(progress).filter((entry) => entry.config.drill === drill && entry.config.hands === hand)
      .reduce((sum, entry) => sum + entry.attempts, 0);
    hands = single.reduce((best, candidate) => practiced(candidate) < practiced(best) ? candidate : best);
  }
  const reach = goal.level <= 3 ? 1 : goal.level <= 6 ? 2 : 4;
  const allowed = spec.octaves.filter((octaves) => hands !== "contrary" || octaves <= 2);
  const within = allowed.filter((octaves) => octaves <= reach);
  const octaves = within.length ? Math.max(...within) : Math.min(...spec.octaves);
  const candidates: DrillSelection[] = [];
  for (const [tonic, mode] of KEY_ORDER) {
    const variant = variantFor(mode);
    if (variant && !(hands === "contrary" && variant === "melodic minor")) candidates.push({ drill, variant, tonic, hands, octaves, inversion: 0, practice: "even" });
  }
  const standing = (config: DrillSelection): [number, number] => {
    const entry = progress[drillConfigKey(config)], qualified = Boolean(entry && entry.best !== null && entry.best >= goal.rung);
    return [Number(qualified), -(entry?.working ?? -1)];
  };
  const config = candidates.reduce((best, candidate) => {
    const a = standing(best), b = standing(candidate);
    return b[0] < a[0] || b[0] === a[0] && b[1] < a[1] ? candidate : best;
  });
  const last: number | null = levels[drill].last;
  const why = focus ? `Training ${spec.name} (level ${level})`
    : last !== null && now - last < 2 * 86400 ? `${spec.name} is your weakest drill (level ${level})`
    : last !== null ? `${spec.name} (level ${level}) has not been practised for a while` : `${spec.name} has not been tried yet`;
  return { config, reason: `${why}. This key is the next step toward level ${goal.level}.` };
}
