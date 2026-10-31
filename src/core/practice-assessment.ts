import { comparePerformance } from "./performance-comparison.ts";
import { median } from "./numeric.ts";
import { pitchName } from "./reading-assessment.ts";
import type { MusicalKey } from "./musical-key.ts";
import type { ProfileEvidence } from "./learner-profile.ts";

export interface PracticeNote { pitch: number; start: number; duration: number; velocity: number }
export interface PracticePrompt {
  target: PracticeNote[]; family: string; challenge: number; title: string;
  key?: MusicalKey | null; shape?: string | null; bpm?: number | null; even?: boolean; dynamics?: string | null; piece_id?: string;
}
export interface PracticeContext { source: string; notation_visible: boolean; hearings: number; reveals: number; hints: number; familiar: boolean }
export interface PracticeQuality { usable: boolean; [key: string]: unknown }

const LABELS: Record<string, string> = {
  "technique.accuracy": "Note accuracy", "technique.evenness": "Even timing", "technique.tempo": "Controlled speed",
  "technique.dynamics": "Even loudness", "technique.scales": "Scale execution", "technique.chords": "Chord execution",
  "reading.pitch": "Reading pitches", "reading.rhythm": "Reading rhythm", "ear.pitch": "Playing back pitches by ear",
  "ear.rhythm": "Playing back rhythm by ear", "theory.scales": "Building scales", "theory.chords": "Building chords",
  "repertoire.recall": "Playing from memory",
};

export function assessPractice(prompt: PracticePrompt, notes: PracticeNote[], context: PracticeContext, quality: PracticeQuality) {
  const result: { version: number; score: Omit<ReturnType<typeof comparePerformance>, "alignment"> | null;
    observations: { index: number; expected: number; start: number; matched: boolean; played_index: number | null; heard: number[] }[];
    evidence: ProfileEvidence[]; quality: PracticeQuality; feedback: string; observed?: { range: number[]; notes: number; duration: number } } = {
    version: 1, score: null, observations: [], evidence: [], quality,
    feedback: "Saved as musical exploration. There is no intended sequence to grade.",
  };
  if (!notes.length) { result.feedback = "No piano notes were recognized. Your levels have not changed."; return result; }
  const target = prompt.target;
  if (!target.length) {
    result.observed = { range: [Math.min(...notes.map((n) => n.pitch)), Math.max(...notes.map((n) => n.pitch))],
      notes: notes.length, duration: Math.max(...notes.map((n) => n.start + n.duration)) };
    return result;
  }
  const score = comparePerformance(target, notes);
  if (prompt.family === "theory") { score.score = score.pitch_accuracy; score.rhythm_accuracy = null; }
  const { alignment, ...summary } = score;
  result.score = summary;
  for (const group of alignment) {
    const available = [...group.played];
    for (const index of group.expected) {
      const position = available.findIndex((j) => notes[j].pitch === target[index].pitch);
      const found = position < 0 ? null : available.splice(position, 1)[0];
      result.observations.push({ index, expected: target[index].pitch, start: target[index].start, matched: found !== null,
        played_index: found, heard: group.played.map((j) => notes[j].pitch) });
    }
  }
  result.observations.sort((a, b) => a.index - b.index);
  if (context.source !== "microphone") { result.feedback = "Demonstration only. Your levels have not changed."; return result; }
  if (!quality.usable) {
    result.feedback = "Saved, but recognition was uncertain. Check the heard notes; this attempt does not affect your levels.";
    return result;
  }
  const family = prompt.family, challenge = prompt.challenge, pitch = score.pitch_accuracy / 100, rhythm = score.rhythm_accuracy;
  const add = (skill: string, value: number, facet = "all", label = LABELS[skill], weight = 1, level = challenge) => {
    if (!LABELS[skill] || !label || value < 0 || value > 1) throw new Error("Invalid skill evidence");
    result.evidence.push({ skill, facet, label, value, weight, challenge: level });
  };
  const executionKnown = (["technique", "repertoire"].includes(family) && (context.notation_visible || context.reveals > 0)) || pitch >= 0.85;
  const assisted = context.reveals > 0 || context.hints > 0 || (context.hearings > 0 && family !== "ear");
  if (executionKnown) add("technique.accuracy", pitch);
  if (rhythm !== null && pitch >= 0.7) {
    const value = rhythm / 100;
    if (prompt.even) add("technique.evenness", value);
    if (prompt.bpm && executionKnown) {
      const speed = Math.min(1, score.tempo_percent / 100) * pitch * value;
      add("technique.tempo", speed); add("technique.tempo", speed, `bpm:${prompt.bpm}`, `${prompt.bpm} BPM`);
    }
  }
  const key = prompt.key, keyId = key ? `key:${key.signature}` : null;
  const name = (p: number) => pitchName(p, key ?? undefined);
  if (prompt.shape === "scale" && executionKnown) {
    const value = rhythm !== null ? pitch * (0.8 + 0.2 * rhythm / 100) : pitch;
    add("technique.scales", value); if (keyId && key) add("technique.scales", value, keyId, key.name);
  }
  const chordValues: number[] = [];
  for (const group of alignment) {
    if (group.expected.length < 2) continue;
    const expected = group.expected.map((i) => target[i].pitch), played = group.played.map((i) => notes[i].pitch);
    const remaining = [...played];
    let matches = 0;
    for (const p of expected) { const i = remaining.indexOf(p); if (i >= 0) { matches++; remaining.splice(i, 1); } }
    const value = 2 * matches / (expected.length + played.length);
    if (executionKnown || value >= 0.85) {
      chordValues.push(value);
      const pitches = [...new Set(expected)].sort((a, b) => a - b);
      add("technique.chords", value, `chord:${pitches.join(",")}`, pitches.map(name).join(" + "));
    }
  }
  if (chordValues.length) {
    const value = chordValues.reduce((a, b) => a + b) / chordValues.length;
    add("technique.chords", value); if (keyId && key) add("technique.chords", value, keyId, key.name);
  }
  const observations = result.observations;
  if (executionKnown) for (let i = 1; i < observations.length; i++) {
    const before = observations[i - 1], after = observations[i];
    if (before.start !== after.start) add("technique.accuracy", Number(before.matched && after.matched),
      `transition:${before.expected}:${after.expected}`, `${name(before.expected)} → ${name(after.expected)}`);
  }
  if (prompt.dynamics === "even" && pitch >= 0.85 && notes.length >= 5) {
    const velocities = notes.map((n) => n.velocity), center = median(velocities);
    const spread = median(velocities.map((v) => Math.abs(v - center))) / Math.max(1, center);
    add("technique.dynamics", Math.exp(-4 * spread), "all", LABELS["technique.dynamics"], 0.4);
  }
  const reading = family === "reading" && !assisted, ear = family === "ear" && context.hearings >= 1 && !context.reveals;
  if (reading || ear) {
    const skill = reading ? "reading.pitch" : "ear.pitch";
    add(skill, pitch, "all", LABELS[skill], ear && context.hearings > 1 ? 0.7 : 1);
    if (rhythm !== null) add(reading ? "reading.rhythm" : "ear.rhythm", rhythm / 100);
    if (keyId && key) add(skill, pitch, keyId, key.name);
    if (reading) {
      const byPitch = new Map<number, boolean[]>(), byClef = new Map<string, boolean[]>();
      for (const row of observations) {
        const pitches = byPitch.get(row.expected) ?? []; pitches.push(row.matched); byPitch.set(row.expected, pitches);
        const clef = row.expected >= 60 ? "treble" : "bass", values = byClef.get(clef) ?? [];
        values.push(row.matched); byClef.set(clef, values);
      }
      const average = (values: boolean[]) => values.filter(Boolean).length / values.length;
      for (const [p, values] of byPitch) add(skill, average(values), `pitch:${p}`, name(p));
      for (const [clef, values] of byClef) add(skill, average(values), `clef:${clef}`, `${clef === "treble" ? "Treble" : "Bass"} clef`);
      for (let i = 1; i < observations.length; i++) {
        const before = observations[i - 1], after = observations[i], interval = after.expected - before.expected;
        if (interval) add(skill, Number(before.matched && after.matched), `interval:${interval}`,
          `${interval > 0 ? "Up" : "Down"} ${Math.abs(interval)} semitones`);
      }
    }
  }
  if (family === "theory" && !assisted && (prompt.shape === "scale" || prompt.shape === "chord")) {
    if (!key || !keyId) throw new Error("Theory tasks require a key");
    const skill = prompt.shape === "scale" ? "theory.scales" : "theory.chords";
    add(skill, pitch); add(skill, pitch, keyId, key.name);
  }
  if (family === "repertoire" && context.familiar && !assisted && !context.notation_visible) {
    if (!prompt.piece_id) throw new Error("Repertoire tasks require a piece");
    add("repertoire.recall", score.score / 100); add("repertoire.recall", score.score / 100, `piece:${prompt.piece_id}`, prompt.title);
  }
  const grouped = new Map<string, ProfileEvidence[]>();
  for (const item of result.evidence) {
    const id = JSON.stringify([item.skill, item.facet]), rows = grouped.get(id) ?? [];
    rows.push(item); grouped.set(id, rows);
  }
  result.evidence = [...grouped.values()].map((items) => ({ ...items[0], value: items.reduce((sum, item) => sum + item.value, 0) / items.length }));
  const mistakes = observations.filter((row) => !row.matched);
  if (mistakes.length) {
    const counts = new Map<number, number>();
    for (const row of mistakes) counts.set(row.expected, (counts.get(row.expected) ?? 0) + 1);
    const most = [...counts].reduce((a, b) => b[1] > a[1] ? b : a)[0];
    result.feedback = `Look at ${name(most)}: ${mistakes.length} expected notes did not match. Try a slower, steady pace.`;
  } else if (score.extra) result.feedback = "The target notes matched, with extra notes heard. Check the transcription before treating these as mistakes.";
  else if (rhythm !== null && rhythm < 85) result.feedback = "The pitches matched. Focus on keeping the spaces between the notes steady.";
  else if (score.tempo_percent < 85 && prompt.bpm) result.feedback = "Accurate at a slower tempo. Keep this control as you work toward the suggested speed.";
  else result.feedback = "That matched well. The next exercise can explore something less familiar.";
  if (assisted && ["reading", "theory", "repertoire"].includes(family)) result.feedback += " Help was used, so this informs execution rather than independent reading or recall.";
  return result;
}
