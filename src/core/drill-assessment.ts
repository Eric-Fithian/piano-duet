import { DRILL_CATALOG } from "./drill-catalog.ts";
import type { DrillId } from "./drill-levels.ts";
import { drillTiming, matchDrillNotes, namingKey, pitchName } from "./drill-timing.ts";
import type { DrillNote } from "./drill-timing.ts";
import type { MusicalKey } from "./musical-key.ts";
import { mean, median, roundEven } from "./numeric.ts";
import { comparePerformance } from "./performance-comparison.ts";

export type DrillConfig = { drill: DrillId; variant: string; tonic: number; hands: string; octaves: number; inversion: number };
export type DrillPrompt = { target: DrillNote[]; bpm: number; challenge: number; key: MusicalKey;
  drill: DrillConfig & { practice: string; per_beat: number; config_key: string; title: string } };
type Quality = { usable: boolean; [key: string]: unknown };
type Evidence = { skill: string; facet: string; label: string; value: number; weight: number; challenge: number };
const CLEAN = { pitch: 90, evenness: 80, drift: 8 };
const LABELS: Record<string, string> = { "technique.accuracy": "Note accuracy", "technique.evenness": "Even timing",
  "technique.tempo": "Controlled speed", "technique.dynamics": "Even loudness", "technique.scales": "Scale execution",
  "technique.arpeggios": "Arpeggio execution", "technique.chords": "Chord execution", "technique.patterns": "Finger patterns" };
const GROUP_SKILLS: Record<string, string> = { Scales: "technique.scales", Arpeggios: "technique.arpeggios",
  Chords: "technique.chords", Patterns: "technique.patterns" };

export function assessDrill(prompt: DrillPrompt, notes: DrillNote[], context: { source: string }, quality: Quality) {
  const seen = new Set<string>();
  const raw = prompt.target.filter((note) => {
    const key = JSON.stringify([note.pitch, note.start]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const result: { version: number; score: Omit<ReturnType<typeof comparePerformance>, "alignment"> | null;
    observations: { index: number; expected: number; start: number; matched: boolean; played_index: number | null; heard: number[] }[];
    evidence: Evidence[]; quality: Quality; feedback: string; drill: unknown } = {
    version: 1, score: null, observations: [], evidence: [], quality,
    feedback: "No piano notes were recognized. Your tempo has not changed.", drill: null };
  if (!notes.length) return result;
  const score = comparePerformance(raw, notes), matched = matchDrillNotes(raw, notes, score.alignment);
  const { alignment, ...summary } = score;
  result.score = summary;
  const spreads: number[] = [];
  for (const group of alignment) {
    const hands = new Map<string, number[]>();
    for (const index of group.expected) {
      const found = matched.get(index);
      if (found !== undefined && raw[index].hand) {
        const values = hands.get(raw[index].hand!) ?? [];
        values.push(notes[found].start); hands.set(raw[index].hand!, values);
      }
      result.observations.push({ index, expected: raw[index].pitch, start: raw[index].start,
        matched: found !== undefined, played_index: found ?? null, heard: group.played.map((index) => notes[index].pitch) });
    }
    if (hands.size === 2) spreads.push(Math.abs(Math.min(...hands.get("right")!) - Math.min(...hands.get("left")!)));
  }
  result.observations.sort((a, b) => a.index - b.index);
  const pitch = score.pitch_accuracy, playedBpm = roundEven(prompt.bpm * score.tempo_percent / 100), drill = prompt.drill;
  const velocities = [...matched.values()].map((index) => notes[index].velocity);
  let loudness: number | null = null, accents: number | null = null;
  if (drill.practice === "even" && velocities.length >= 5) {
    const center = median(velocities);
    loudness = roundEven(100 * Math.exp(-4 * median(velocities.map((value) => Math.abs(value - center))) / Math.max(1, center)));
  }
  if (drill.practice.startsWith("accent")) {
    const hits: boolean[] = [];
    for (const [index, played] of matched) {
      if (!raw[index].accent) continue;
      const neighbours = [...matched].filter(([other]) => Math.abs(raw[other].start - raw[index].start) <= 60 / prompt.bpm && !raw[other].accent)
        .map(([, other]) => notes[other].velocity);
      if (neighbours.length) hits.push(notes[played].velocity >= median(neighbours) + 8);
    }
    if (hits.length) accents = roundEven(100 * hits.filter(Boolean).length / hits.length);
  }
  const usable = context.source === "microphone" && quality.usable;
  const profile = drillTiming(raw, notes, matched, alignment, prompt.bpm, prompt.key), drift = profile.drift_percent;
  const ladder = DRILL_CATALOG.drills[drill.drill].ladder;
  const rate = drill.per_beat * (profile.bpm ?? 0) * 1.03;
  const credited = profile.bpm ? ladder.findLastIndex((tempo) => tempo.per_beat * tempo.bpm <= rate + 1e-9) : -1;
  const credit = credited < 0 ? null : credited;
  if (drift !== null && Math.abs(drift) > CLEAN.drift) {
    profile.issues = [`The tempo ${drift > 0 ? "sped up" : "slowed down"} ${Math.abs(drift)}% from the first third of the take to the last`, ...profile.issues].slice(0, 5);
  }
  const deviations = profile.timeline.map((row) => row.deviation_ms).filter((value): value is number => value !== null).map((value) => value / 1000);
  const evenness = deviations.length >= 2 ? roundEven(100 * mean(deviations.map((value) => Math.exp(-Math.max(0, Math.abs(value) - 0.06) / 0.18)))) : null;
  const timingMs = deviations.length >= 2 ? roundEven(1000 * mean(deviations.map(Math.abs))) : null;
  const clean = usable && drill.practice === "even" && profile.pauses === 0 && evenness !== null && pitch >= CLEAN.pitch
    && evenness >= CLEAN.evenness && (drift === null || Math.abs(drift) <= CLEAN.drift) && credit !== null;
  result.drill = { usable, clean, pitch, evenness, played_bpm: playedBpm, loudness, accents,
    sync_ms: spreads.length ? roundEven(1000 * median(spreads)) : null, timing_ms: timingMs, suggested_bpm: prompt.bpm,
    credit, targets: CLEAN, ...profile };
  if (context.source !== "microphone") { result.feedback = "Demonstration only. Your tempo has not changed."; return result; }
  if (!quality.usable) { result.feedback = "Saved, but recognition was uncertain. Check the heard notes; this attempt does not move your tempo."; return result; }
  const add = (skill: string, value: number, facet = "all", label = LABELS[skill], weight = 1) => {
    if (!(skill in LABELS) || value < 0 || value > 1) throw new Error("Invalid skill evidence");
    result.evidence.push({ skill, facet, label, value, weight, challenge: prompt.challenge });
  };
  add("technique.accuracy", pitch / 100);
  if (evenness !== null && pitch >= 70 && drill.practice === "even") add("technique.evenness", evenness / 100);
  if (clean && credit !== null) {
    const spec = DRILL_CATALOG.drills[drill.drill], start = ladder[spec.start], top = ladder.at(-1)!, tempo = ladder[credit];
    const speed = Math.max(0, Math.min(1, (tempo.per_beat * tempo.bpm - start.per_beat * start.bpm) / (top.per_beat * top.bpm - start.per_beat * start.bpm)));
    add("technique.tempo", speed); add("technique.tempo", speed, `bpm:${tempo.bpm}`, `${tempo.bpm} BPM`);
  }
  if (loudness !== null && pitch >= 85) add("technique.dynamics", loudness / 100, "all", LABELS["technique.dynamics"], 0.4);
  const skill = GROUP_SKILLS[DRILL_CATALOG.drills[drill.drill].group];
  const value = evenness !== null ? pitch / 100 * (0.8 + 0.2 * evenness / 100) : pitch / 100;
  add(skill, value); add(skill, value, `key:${prompt.key.signature}`, prompt.key.name); add(skill, value, `drill:${drill.config_key}`, drill.title);
  const misses = result.observations.filter((row) => !row.matched), pauses = profile.pauses;
  if (clean) result.feedback = `Clean and steady at ♩ ${playedBpm}.`;
  else if (pauses && pitch >= CLEAN.pitch) result.feedback = `Accurate, but ${pauses} pause${pauses > 1 ? "s" : ""} kept it from being clean. Play through the spot slowly until it flows.`;
  else if (misses.length) {
    const counts = new Map<number, number>();
    for (const row of misses) counts.set(row.expected, (counts.get(row.expected) ?? 0) + 1);
    const worst = [...counts].reduce((best, item) => item[1] > best[1] ? item : best)[0];
    result.feedback = `${misses.length} expected notes did not match, most often ${pitchName(worst, namingKey(prompt.key))}. Slow down until every note is secure.`;
  } else if (evenness !== null && evenness < CLEAN.evenness) result.feedback = "The notes were right; the spacing was uneven. Listen for equal gaps, especially at thumb crossings.";
  else if (drift !== null && Math.abs(drift) > CLEAN.drift) result.feedback = `You ${drift > 0 ? "sped up" : "slowed down"} ${Math.abs(drift)}% over the take. Settle on one tempo you can hold, slower if need be.`;
  else if (drill.practice !== "even") result.feedback = "Rhythm and accent practice is recorded. Switch back to even notes to move your tempo.";
  else result.feedback = "Close. Another pass at this tempo.";
  if (accents !== null) result.feedback += ` Accents stood out on ${accents}% of the accented notes.`;
  return result;
}
