import { mean, median, roundDecimal, roundEven } from "./numeric.ts";
import { READING_STAGES } from "./reading-stages.ts";

export interface TimedObservation {
  index: number;
  start: number;
  heard_at: number;
  group: number;
  confidence: number;
  matched: boolean;
}
export interface TimingTask {
  bpm: number;
  reading: { stage_id?: string | null; positions: { index: number }[] };
}
export interface TimingContext { reading_timing?: { interruptions: number[] } | null }
export interface RhythmResult { accuracy: number | null; bpm: number | null; coverage: number; intervals: number }

export function readingTiming(task: TimingTask, observations: TimedObservation[], context: TimingContext): RhythmResult {
  const attacks = observations.filter((row, index) => index === 0 || row.start !== observations[index - 1].start);
  const stageId = task.reading.stage_id;
  const stage = stageId && stageId !== "rests" ? READING_STAGES.find((item) => item.id === stageId) : null;
  if (stageId && stageId !== "rests" && !stage) throw new Error(`Unknown reading stage ${stageId}`);
  const withinPosition = !stage || stage.rhythm_scope === "within_position";
  const landings = new Set(task.reading.positions.map((position) => position.index));
  if (!context.reading_timing) return { accuracy: null, bpm: null, coverage: 0, intervals: 0 };
  const periods: number[] = [];
  const intervals: [number, number][] = [];
  let eligible = 0;
  for (let index = 1; index < attacks.length; index++) {
    const left = attacks[index - 1], right = attacks[index];
    if (withinPosition && landings.has(right.index)) continue;
    eligible++;
    const written = (right.start - left.start) * task.bpm / 60;
    const elapsed = right.heard_at - left.heard_at;
    if (written <= 0) throw new Error("Reading attack positions must increase");
    const interrupted = context.reading_timing.interruptions.some((point) => left.group < point && point <= right.group);
    if (interrupted || elapsed > 10 || elapsed <= 0 || Math.min(left.confidence, right.confidence) < 0.8 || !left.matched || !right.matched) continue;
    intervals.push([written, elapsed]);
    periods.push(elapsed / written);
  }
  const coverage = intervals.length / Math.max(1, eligible);
  if (periods.length < (withinPosition ? 2 : 3) || coverage < 0.75) {
    return { accuracy: null, bpm: null, coverage: roundDecimal(coverage, 2), intervals: periods.length };
  }
  const period = median(periods);
  const values = intervals.map(([written, elapsed]) => Math.max(0,
    1 - Math.max(0, Math.abs(elapsed - written * period) - 0.08) / Math.max(0.12, written * period * 0.5)));
  return { accuracy: roundEven(100 * mean(values)), bpm: roundEven(60 / period),
    coverage: roundDecimal(coverage, 2), intervals: periods.length };
}
