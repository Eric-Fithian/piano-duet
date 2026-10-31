import { median, roundDecimal, roundEven } from "./numeric.ts";
import type { TimedObservation, TimingContext } from "./reading-timing.ts";

const PAUSE_LIMIT = 10;
const ALPHA = 1 - 2 ** (-1 / 5);
export interface PositionChange {
  index: number; clef: string; pitch: number; finger: number | null; shift_steps: number;
  extra_seconds: number | null; extra_beats: number | null; bpm: number | null;
  arrival_seconds?: number | null; arrival_reason?: string | null;
  [key: string]: unknown;
}
export type LandingChange = PositionChange & { arrival_seconds: number | null; arrival_reason: string | null };

export function measureLandings(changes: PositionChange[], observations: TimedObservation[], context: TimingContext & { introduction?: boolean }): LandingChange[] {
  const measured: LandingChange[] = [];
  for (const change of changes) {
    const landing = observations[change.index];
    const previous = observations.slice(0, change.index).findLast((row) => row.start < landing.start);
    if (!previous) continue;
    const gap = landing.heard_at - previous.heard_at;
    let reason: string | null = null;
    if (context.introduction) reason = "Note introductions show the answer.";
    else if (!context.reading_timing) reason = "Recording continuity was not tracked.";
    else if (Math.min(previous.confidence, landing.confidence) < 0.8) reason = "Recognition at the change was uncertain.";
    else if (context.reading_timing.interruptions.some((point) => previous.group < point && point <= landing.group)) reason = "Recording was interrupted during this change.";
    else if (gap <= 0) reason = "The two attacks could not be timed separately.";
    else if (gap > PAUSE_LIMIT) reason = "A long pause made this change unsuitable for timing.";
    measured.push({ ...change, arrival_seconds: reason === null ? roundDecimal(gap, 3) : null, arrival_reason: reason });
  }
  return measured;
}

type Field = "extra_seconds" | "extra_beats" | "bpm" | "arrival_seconds";
function valueOf(row: LandingChange, field: Field): number {
  const value = row[field];
  if (typeof value !== "number") throw new Error(`Missing fluency value ${field}`);
  return value;
}
function fluencyAverage(rows: LandingChange[], field: Field): number | null {
  if (!rows.length) return null;
  let value = valueOf(rows[0], field);
  for (const row of rows.slice(1)) value += ALPHA * (valueOf(row, field) - value);
  return roundDecimal(value, 2);
}
function filterFluency(changes: LandingChange[], field: "extra_seconds" | "arrival_seconds"): { rows: LandingChange[]; excluded: Set<number> } {
  const byPitch = new Map<string, { index: number; row: LandingChange }[]>();
  const excluded = new Set<number>();
  changes.forEach((row, index) => {
    if (row.arrival_seconds === null || row.arrival_seconds > PAUSE_LIMIT) excluded.add(index);
    else {
      const key = JSON.stringify([row.clef, row.pitch]);
      const group = byPitch.get(key) ?? [];
      group.push({ index, row });
      byPitch.set(key, group);
    }
  });
  for (const rows of byPitch.values()) rows.forEach(({ index, row }, position) => {
    const nearby = rows.slice(Math.max(0, position - 10), position + 11);
    if (nearby.length < 5) return;
    const center = median(nearby.map((item) => valueOf(item.row, field)));
    const deviation = median(nearby.map((item) => Math.abs(valueOf(item.row, field) - center)));
    const ceiling = center + Math.max(1.5, 4 * 1.4826 * deviation);
    const neighbors = [...rows.slice(Math.max(0, position - 1), position), ...rows.slice(position + 1, position + 2)];
    if (valueOf(row, field) > ceiling && !neighbors.some((item) => valueOf(item.row, field) > ceiling)) excluded.add(index);
  });
  return { rows: changes.filter((_, index) => !excluded.has(index)), excluded };
}

export function summarizeFluency(changes: LandingChange[]) {
  const timed = changes.filter((change) => change.extra_seconds !== null);
  const { rows: measured, excluded: outliers } = filterFluency(timed, "extra_seconds");
  const arrivals = changes.filter((change) => change.arrival_seconds !== null);
  const { rows: landings, excluded: landingOutliers } = filterFluency(arrivals, "arrival_seconds");
  const window = measured.length >= 10 ? Math.min(20, Math.floor(measured.length / 2)) : measured.length;
  const recent = window ? measured.slice(-window) : [];
  const earlier = measured.length >= 10 ? measured.slice(-2 * window, -window) : [];
  const contexts = new Map<string, { pitch: number; finger: number | null; shift: number; rows: LandingChange[] }>();
  for (const change of measured) {
    const key = JSON.stringify([change.pitch, change.finger, change.shift_steps]);
    const group = contexts.get(key) ?? { pitch: change.pitch, finger: change.finger, shift: change.shift_steps, rows: [] };
    group.rows.push(change);
    contexts.set(key, group);
  }
  return {
    samples: measured.length, untimed: changes.length - timed.length, outliers: outliers.size, recent_samples: recent.length,
    extra_seconds: fluencyAverage(recent, "extra_seconds"), extra_beats: fluencyAverage(recent, "extra_beats"),
    bpm: recent.length ? roundEven(fluencyAverage(recent, "bpm")!) : null,
    previous_seconds: fluencyAverage(earlier, "extra_seconds"), previous_beats: fluencyAverage(earlier, "extra_beats"),
    landings: [...new Set(arrivals.map((row) => row.pitch))].sort((a, b) => a - b).map((pitch) => {
      const rows = landings.filter((row) => row.pitch === pitch);
      return { pitch, samples: rows.length, arrival_seconds: fluencyAverage(rows, "arrival_seconds"),
        outliers: [...landingOutliers].filter((index) => arrivals[index].pitch === pitch).length };
    }),
    transitions: [...contexts.values()].sort((a, b) => a.pitch - b.pitch || (a.finger ?? 0) - (b.finger ?? 0) || a.shift - b.shift)
      .map(({ pitch, finger, shift, rows }) => ({ pitch, finger, shift_steps: shift, samples: rows.length,
        extra_beats: roundDecimal(median(rows.slice(-5).map((row) => valueOf(row, "extra_beats"))), 2) })),
  };
}
