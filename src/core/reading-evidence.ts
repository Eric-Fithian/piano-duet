import { mean, roundEven } from "./numeric.ts";

export interface ReadingObservation {
  index: number;
  expected: number;
  matched: boolean;
}

export interface ReadingEvidencePrompt {
  reading?: { segments?: number[]; clef?: string };
  target: { staff?: string | null }[];
}

export interface ReadingRow {
  pitch: number;
  clef: string;
  kind: "starts" | "patterns" | "shifts";
  interval: number | null;
  value: number;
}

export interface ReadingSample extends ReadingRow {
  attempt: number | string;
}

export function readingRows(prompt: ReadingEvidencePrompt, observations: ReadingObservation[]): ReadingRow[] {
  const segments = prompt.reading?.segments ?? [0];
  const clef = prompt.reading?.clef;
  const previous = new Map<string, number>();
  return observations.map((row) => {
    const start = segments.includes(row.index);
    const staff = prompt.target[row.index].staff || (clef === "treble" || clef === "bass" ? clef : row.expected >= 60 ? "treble" : "bass");
    const result: ReadingRow = {
      pitch: row.expected,
      clef: staff,
      kind: start ? (previous.has(staff) ? "shifts" : "starts") : "patterns",
      interval: start ? null : row.expected - (previous.get(staff) ?? row.expected),
      value: Number(row.matched),
    };
    previous.set(staff, row.expected);
    return result;
  });
}

export function summarizeReading(rows: ReadingSample[]): {
  accuracy: number | null; samples: number; attempts: number; ready: boolean; status: string;
} {
  const recent = rows.slice(-32);
  const accuracy = recent.length ? roundEven(100 * mean(recent.map((row) => row.value))) : null;
  const contexts = new Set(recent.map((row) => JSON.stringify([row.pitch, row.interval])));
  const attempts = new Set(recent.map((row) => row.attempt)).size;
  const ready = accuracy !== null && accuracy >= 85 && recent.length >= 6 && attempts >= 3 && contexts.size >= 3;
  return {
    accuracy,
    samples: rows.length,
    attempts,
    ready,
    status: ready ? "Steady" : !recent.length ? "New" : attempts >= 3 && accuracy! < 70 ? "Needs practice" : "Building",
  };
}
