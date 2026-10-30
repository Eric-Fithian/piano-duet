import { musicalKey } from "./musical-key.ts";
import type { KeyMode, MusicalKey } from "./musical-key.ts";

export interface ContextStage {
  id: string;
  texture: string;
  keys: [number, KeyMode][];
  meters: string[];
}
export interface ContextProgress {
  curriculum: {
    contexts: { clef: string; key: string; meter: string; samples: number }[];
    path: { id: string; groups: { hand: string; ready: boolean }[] }[];
    demonstrated_keys: string[];
  };
}
export interface RandomChoice {
  choice<T>(options: T[]): T;
}

export function chooseContext(stage: ContextStage, progress: ContextProgress, rng: RandomChoice): [string, MusicalKey, string] {
  const contexts = progress.curriculum.contexts;
  let clefs = ["single", "dyads"].includes(stage.texture) ? ["treble", "bass"] : ["grand"];
  const requirements = progress.curriculum.path.find((row) => row.id === stage.id);
  if (!requirements) throw new Error(`Missing stage requirements for ${stage.id}`);
  const unfinished = requirements.groups.filter((group) => !group.ready).map((group) => group.hand);
  if (unfinished.length) clefs = clefs.filter((clef) => unfinished.includes(clef));
  const count = (field: "clef" | "key" | "meter", value: string) => contexts.filter((row) => row[field] === value).reduce((sum, row) => sum + row.samples, 0);
  const fewest = <T>(options: T[], score: (value: T) => number): T[] => {
    if (!options.length) throw new Error("A reading context needs at least one option");
    const minimum = Math.min(...options.map(score));
    return options.filter((option) => score(option) === minimum);
  };
  const clef = rng.choice(fewest(clefs, (value) => count("clef", value)));
  let keys = stage.keys.map(([tonic, mode]) => musicalKey(tonic, mode));
  if (["first_keys", "minor", "more_keys", "all_keys"].includes(stage.id)) {
    const unfamiliar = keys.filter((key) => !progress.curriculum.demonstrated_keys.includes(key.signature));
    const accidentals = (key: MusicalKey) => key.scale_names.reduce((sum, name) => sum + name.length - 1, 0);
    if (unfamiliar.length) {
      const limit = Math.min(...unfamiliar.map(accidentals));
      keys = keys.filter((key) => accidentals(key) <= limit);
    }
  }
  const key = rng.choice(fewest(keys, (value) => count("key", value.signature)));
  const meter = rng.choice(fewest(stage.meters, (value) => count("meter", value)));
  return [clef, key, meter];
}
