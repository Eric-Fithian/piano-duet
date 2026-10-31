import { readingRows } from "./reading-evidence.ts";
import { measureLandings } from "./reading-fluency.ts";
import type { LandingChange, PositionChange } from "./reading-fluency.ts";
import type { ReadingScore } from "./reading-composer.ts";
import type { MusicalKey } from "./musical-key.ts";
import { mean, median, roundDecimal, roundEven } from "./numeric.ts";
import { readingAttacks } from "./reading-score.ts";
import { readingTiming } from "./reading-timing.ts";
import type { TimedObservation, TimingContext } from "./reading-timing.ts";

export interface HeardNote { pitch: number; start: number; velocity: number; confidence: number }
export interface ReadingObservation extends TimedObservation { expected: number; heard: number[]; tries: number[][] }
export interface ReadingAssessmentContext extends TimingContext { hearings: number; reveals: number; hints: number; introduction?: boolean }
export interface ReadingEvidence { skill: string; facet: string; label: string; value: number; weight: number; challenge: number }

export function matchesReading(pitches: number[], expected: number[]): boolean {
  return expected.every((pitch) => pitches.includes(pitch)) && pitches.every((pitch) => expected.some((target) => (pitch - target) % 12 === 0));
}

export function pitchName(pitch: number, key?: MusicalKey): string {
  const index = key?.pitch_classes.indexOf(pitch % 12) ?? -1;
  if (key && index >= 0) {
    const name = key.scale_names[index];
    const natural: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const semitone = natural[name[0]] + [...name].filter((value) => value === "#").length - [...name].filter((value) => value === "b").length;
    return name.replaceAll("#", "♯").replaceAll("b", "♭") + (Math.floor((pitch - semitone) / 12) - 1);
  }
  return ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][pitch % 12] + (Math.floor(pitch / 12) - 1);
}

function positionChanges(task: ReadingScore, observations: ReadingObservation[], context: ReadingAssessmentContext, usable: boolean, assisted: boolean): LandingChange[] {
  const changes: PositionChange[] = [];
  const byStaff = new Map<string, ReadingScore["reading"]["positions"]>();
  for (const position of task.reading.positions) {
    const clef = position.clef ?? task.reading.clef;
    const group = byStaff.get(clef) ?? [];
    group.push(position);
    byStaff.set(clef, group);
  }
  for (const positions of byStaff.values()) for (let i = 1; i < positions.length; i++) {
    const preceding = positions[i - 1], position = positions[i];
    const index = position.index, clef = position.clef ?? task.reading.clef;
    const change: PositionChange = { index, clef, hand: position.hand ?? task.reading.hand, pitch: task.target[index].pitch,
      finger: position.finger, from_position: preceding.low, to_position: position.low, shift_steps: position.low - preceding.low,
      extra_seconds: null, extra_beats: null, bpm: null, reason: null };
    changes.push(change);
    const baseline: ReadingObservation[] = [];
    for (const row of observations.slice(preceding.index, index)) {
      if ((task.target[row.index].staff ?? task.reading.clef) === clef && (!baseline.length || row.start !== baseline.at(-1)!.start)) baseline.push(row);
    }
    const recent = baseline.slice(-4), landing = observations[index];
    let reason: string | null = null;
    if (assisted) reason = "Assisted practice or a note introduction.";
    else if (!usable || [...recent, landing].some((row) => row.confidence < 0.8)) reason = "Recognition was uncertain.";
    else if (!context.reading_timing) reason = "Recording continuity was not tracked.";
    else if (recent.length < 4) reason = "Play four notes before the change to establish a pace.";
    else if ([...recent, landing].some((row) => !row.matched)) reason = "The preceding bar or landing needed a correction.";
    else if (context.reading_timing.interruptions.some((boundary) => recent[0].group < boundary && boundary <= landing.group)) reason = "Recording was interrupted during this change.";
    if (reason) { change.reason = reason; continue; }
    const periods = recent.slice(1).map((right, j) => (right.heard_at - recent[j].heard_at) / ((right.start - recent[j].start) * task.bpm / 60));
    const period = median(periods);
    if (period <= 0 || periods.some((value) => Math.abs(value - period) > Math.max(0.08, period * 0.25))) {
      change.reason = "The first bar did not establish a steady pace."; continue;
    }
    const expected = (landing.start - recent.at(-1)!.start) * task.bpm / 60 * period;
    const gap = landing.heard_at - recent.at(-1)!.heard_at;
    if (gap > Math.min(10, Math.max(6, expected * 4))) { change.reason = "A long pause made this change unsuitable for timing."; continue; }
    if (gap < expected * 0.75) { change.reason = "The landing was substantially ahead of your established pulse."; continue; }
    change.extra_seconds = roundDecimal(Math.max(0, gap - expected), 3);
    change.extra_beats = roundDecimal(Math.max(0, gap - expected) / period, 3);
    change.bpm = roundDecimal(60 / period, 1);
  }
  return measureLandings(changes, observations, context);
}

export function assessReading(task: ReadingScore, groups: HeardNote[][], context: ReadingAssessmentContext) {
  const target = task.target, attacks = readingAttacks(target), observations: ReadingObservation[] = [];
  const notes: { pitch: number; start: number; velocity: number; duration: number }[] = [];
  const strengths: number[] = [];
  let attempts: number[][] = [], cursor = 0, previous = -1;
  groups.forEach((group, groupIndex) => {
    if (!group.length) throw new Error("Reading attacks cannot be empty");
    const start = Math.min(...group.map((note) => note.start));
    if (start < previous || cursor >= attacks.length) throw new Error("Reading attacks must be chronological and end with the last target");
    previous = start;
    const pitches = group.map((note) => note.pitch);
    attempts.push(pitches);
    notes.push(...group.map((note) => ({ pitch: note.pitch, start: note.start, velocity: note.velocity, duration: 0.1 })));
    strengths.push(...group.map((note) => note.confidence));
    if (!matchesReading(pitches, attacks[cursor].indices.map((index) => target[index].pitch))) return;
    for (const index of attacks[cursor].indices) observations.push({ index, expected: target[index].pitch,
      start: target[index].start, heard_at: start, group: groupIndex, confidence: Math.min(...group.map((note) => note.confidence)),
      matched: attempts.length === 1, heard: attempts.flat(), tries: attempts });
    cursor++;
    attempts = [];
  });
  if (cursor !== attacks.length) throw new Error("Finish every note in the score before saving the reading");
  const firstTry = observations.filter((row) => row.matched).length, accuracy = firstTry / target.length;
  const usable = mean(strengths) >= 0.75 && mean(strengths.map((value) => Number(value >= 0.6))) >= 0.8;
  const assisted = Boolean(context.hearings || context.reveals || context.hints || context.introduction);
  const fluency = positionChanges(task, observations, context, usable, assisted);
  const rhythm = readingTiming(task, observations, context);
  const assessment = { version: 1, score: { score: roundEven(accuracy * 100), pitch_accuracy: roundEven(accuracy * 100),
    rhythm_accuracy: task.reading.rhythm_required ? rhythm.accuracy : null, first_try: firstTry, total: target.length,
    corrections: groups.length - attacks.length }, observations, evidence: [] as ReadingEvidence[], fluency, rhythm,
    quality: { usable, onset_support: roundDecimal(mean(strengths), 3), reason: "Live onset support; position-change timing is separate from pitch accuracy" },
    feedback: `${firstTry} of ${target.length} notes right on the first try. Position-change timing does not change this score.` };
  if (!usable || assisted) {
    assessment.feedback += context.introduction ? " Introduction completed; the answer was shown, so this does not raise your reading rating."
      : assisted ? " Saved as assisted practice." : " Recognition was uncertain; levels were not changed.";
    return { assessment, notes };
  }
  const facets = new Map<string, { facet: string; label: string; values: number[] }>();
  const add = (facet: string, label: string, value: number) => {
    const key = JSON.stringify([facet, label]);
    const item = facets.get(key) ?? { facet, label, values: [] };
    item.values.push(value);
    facets.set(key, item);
  };
  for (const row of observations) {
    const value = Number(row.matched), clef = target[row.index].staff ?? task.reading.clef;
    add("all", "Reading pitches", value);
    add(`pitch:${row.expected}`, pitchName(row.expected, task.key), value);
    add(`clef:${clef}`, `${clef[0].toUpperCase()}${clef.slice(1)} clef`, value);
    add(`key:${task.key.signature}`, task.key.name, value);
  }
  const labels = { starts: "Finding a starting note", patterns: "Following steps and skips", shifts: "Reading after a position change" };
  for (const row of readingRows(task, observations)) {
    add(`position:${row.kind}`, labels[row.kind], row.value);
    if (row.kind === "starts" || row.kind === "shifts") add(`start:${row.pitch}`, `Starting on ${pitchName(row.pitch, task.key)}`, row.value);
    else add(`transition:${row.interval}`, `Reading a ${row.interval! >= 0 ? "+" : ""}${row.interval}-semitone movement`, row.value);
  }
  assessment.evidence = [...facets.values()].map(({ facet, label, values }) => ({ skill: "reading.pitch", facet, label,
    value: mean(values), weight: 1, challenge: task.challenge }));
  if (task.reading.rhythm_required && rhythm.accuracy !== null) {
    assessment.evidence.push({ skill: "reading.rhythm", facet: "all", label: "Reading rhythm", value: rhythm.accuracy / 100, weight: 1, challenge: task.challenge });
    assessment.feedback += ` Rhythm ${rhythm.accuracy}% at ${rhythm.bpm} BPM.`;
  }
  return { assessment, notes };
}
