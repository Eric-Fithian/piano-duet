import { mean, median, roundEven } from "./numeric.ts";

export interface StageRequirementsInput {
  id: string;
  number: number;
  required_scores: number;
  texture: string;
  rhythm_required: boolean;
  tempo: number;
  keys: unknown[];
  meters: string[];
}

export interface StageRecord {
  clef: string;
  key: string;
  meter: string;
  pitch_values: number[];
  pitches: number[];
  rhythm: { accuracy: number | null; bpm: number | null };
}

export function stageRequirements(stage: StageRequirementsInput, records: StageRecord[]) {
  const recent = records.slice(-24);
  const required = stage.required_scores;
  const hands = ["single", "dyads"].includes(stage.texture) ? ["treble", "bass"] : ["grand"];
  const groups = hands.map((hand) => {
    const rows = recent.filter((row) => row.clef === hand).slice(-required);
    const pitches = rows.flatMap((row) => row.pitch_values);
    const accuracy = pitches.length ? roundEven(100 * mean(pitches)) : null;
    const rhythms = rows.flatMap((row) => row.rhythm.accuracy === null ? [] : [row.rhythm.accuracy]);
    const tempos = rows.flatMap((row) => row.rhythm.bpm === null ? [] : [row.rhythm.bpm]);
    const rhythm = rhythms.length ? roundEven(mean(rhythms)) : null;
    const tempo = tempos.length ? roundEven(median(tempos)) : null;
    const ready = rows.length >= required && accuracy !== null && accuracy >= 90
      && (!stage.rhythm_required || (rhythms.length >= required && rhythm !== null && rhythm >= 80))
      && (!stage.tempo || (tempo !== null && tempo >= stage.tempo));
    return { hand, samples: rows.length, required, accuracy, rhythm, rhythm_samples: rhythms.length, bpm: tempo, ready };
  });
  const successful = records.filter((row) => mean(row.pitch_values) >= 0.9
    && (!stage.rhythm_required || (row.rhythm.accuracy !== null && row.rhythm.accuracy >= 80))
    && (!stage.tempo || (row.rhythm.bpm ?? 0) >= stage.tempo));
  const keys = new Set(successful.map((row) => row.key));
  const requiredKeys = ["first_keys", "minor", "more_keys", "all_keys"].includes(stage.id)
    ? stage.keys.length : Math.min(3, stage.keys.length);
  const meters = new Set(successful.map((row) => row.meter));
  const requiredMeters = stage.id === "meters" ? stage.meters.length : 1;
  const notes: boolean[] = [];
  if (stage.number <= 2) {
    const vocabulary: Record<string, number[]> = {
      treble: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76],
      bass: [48, 50, 52, 53, 55, 57, 59],
    };
    for (const [hand, pitches] of Object.entries(vocabulary)) {
      for (const pitch of stage.number === 1 ? pitches.slice(0, 3) : pitches) {
        const values = records.filter((row) => row.clef === hand).flatMap((row) => {
          if (row.pitches.length !== row.pitch_values.length) throw new Error("Pitch and value counts must match");
          return row.pitches.flatMap((expected, index) => expected === pitch ? [row.pitch_values[index]] : []);
        }).slice(-8);
        notes.push(values.length >= 3 && mean(values) >= 0.85);
      }
    }
  }
  return {
    groups,
    keys: keys.size,
    key_signatures: [...keys].sort(),
    required_keys: requiredKeys,
    meters: meters.size,
    required_meters: requiredMeters,
    notes: notes.filter(Boolean).length,
    required_notes: notes.length,
    ready: groups.every((group) => group.ready) && notes.every(Boolean)
      && keys.size >= requiredKeys && meters.size >= requiredMeters,
  };
}
