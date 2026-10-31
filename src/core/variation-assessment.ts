import { comparePerformance } from "./performance-comparison.ts";
import type { ContextNote } from "./aria-tokenizer.ts";
import type { MusicalKey } from "./musical-key.ts";
import type { ProfileEvidence } from "./learner-profile.ts";

type Quality = { usable: boolean; [key: string]: unknown };
type Observation = { index: number; expected: number; start: number; matched: boolean; played_index: number | null; heard: number[] };

export function assessVariation(target: ContextNote[], notes: ContextNote[], key: MusicalKey | null, source: string, quality: Quality) {
  const result: { version: number; score: Omit<ReturnType<typeof comparePerformance>, "alignment"> | null; observations: Observation[];
    evidence: ProfileEvidence[]; quality: Quality; feedback: string; observed?: { range: number[]; notes: number; duration: number } } = {
    version: 1, score: null, observations: [], evidence: [], quality, feedback: "Saved as musical exploration. There is no intended sequence to grade.",
  };
  if (!notes.length) { result.feedback = "No piano notes were recognized. Your levels have not changed."; return result; }
  if (!target.length) {
    result.observed = { range: [Math.min(...notes.map((note) => note.pitch)), Math.max(...notes.map((note) => note.pitch))],
      notes: notes.length, duration: Math.max(...notes.map((note) => note.start + note.duration)) };
    return result;
  }
  const comparison = comparePerformance(target, notes), { alignment, ...score } = comparison;
  result.score = score;
  for (const group of alignment) {
    const available = [...group.played];
    for (const index of group.expected) {
      const found = available.find((played) => notes[played].pitch === target[index].pitch);
      if (found !== undefined) available.splice(available.indexOf(found), 1);
      result.observations.push({ index, expected: target[index].pitch, start: target[index].start, matched: found !== undefined,
        played_index: found ?? null, heard: group.played.map((played) => notes[played].pitch) });
    }
  }
  result.observations.sort((a, b) => a.index - b.index);
  if (source !== "microphone") { result.feedback = "Demonstration only. Your levels have not changed."; return result; }
  if (!quality.usable) { result.feedback = "Saved, but recognition was uncertain. Check the heard notes; this attempt does not affect your levels."; return result; }
  const evidence: ProfileEvidence[] = [];
  const add = (skill: string, value: number, facet: string, label: string) => evidence.push({ skill, facet, label, value, weight: 1, challenge: 1 });
  const executionKnown = score.pitch_accuracy >= 85;
  if (executionKnown) add("technique.accuracy", score.pitch_accuracy / 100, "all", "Note accuracy");
  const chordValues: number[] = [];
  for (const group of alignment) {
    if (group.expected.length < 2) continue;
    const expected = group.expected.map((index) => target[index].pitch), played = group.played.map((index) => notes[index].pitch);
    const remaining = [...played];
    let shared = 0;
    for (const pitch of expected) { const index = remaining.indexOf(pitch); if (index !== -1) { remaining.splice(index, 1); shared++; } }
    const value = 2 * shared / (expected.length + played.length);
    if (executionKnown || value >= 0.85) {
      chordValues.push(value);
      const pitches = [...new Set(expected)].sort((a, b) => a - b);
      add("technique.chords", value, `chord:${pitches.join(",")}`, pitches.map((pitch) => pitchName(pitch, key)).join(" + "));
    }
  }
  if (chordValues.length) {
    const value = chordValues.reduce((sum, item) => sum + item, 0) / chordValues.length;
    add("technique.chords", value, "all", "Chord execution");
    if (key) add("technique.chords", value, `key:${key.signature}`, key.name);
  }
  if (executionKnown) for (let index = 1; index < result.observations.length; index++) {
    const before = result.observations[index - 1], after = result.observations[index];
    if (before.start !== after.start) add("technique.accuracy", Number(before.matched && after.matched),
      `transition:${before.expected}:${after.expected}`, `${pitchName(before.expected, key)} → ${pitchName(after.expected, key)}`);
  }
  const grouped = new Map<string, ProfileEvidence[]>();
  for (const item of evidence) { const id = JSON.stringify([item.skill, item.facet]); grouped.set(id, [...(grouped.get(id) ?? []), item]); }
  result.evidence = [...grouped.values()].map((items) => ({ ...items[0], value: items.reduce((sum, item) => sum + item.value, 0) / items.length }));
  const mistakes = result.observations.filter((row) => !row.matched);
  if (mistakes.length) {
    const counts = new Map<number, number>();
    for (const row of mistakes) counts.set(row.expected, (counts.get(row.expected) ?? 0) + 1);
    const pitch = [...counts].reduce((best, item) => item[1] > best[1] ? item : best)[0];
    result.feedback = `Look at ${pitchName(pitch, key)}: ${mistakes.length} expected notes did not match. Try a slower, steady pace.`;
  } else if (score.extra) result.feedback = "The target notes matched, with extra notes heard. Check the transcription before treating these as mistakes.";
  else if (score.rhythm_accuracy !== null && score.rhythm_accuracy < 85) result.feedback = "The pitches matched. Focus on keeping the spaces between the notes steady.";
  else result.feedback = "That matched well. The next exercise can explore something less familiar.";
  return result;
}

function pitchName(pitch: number, key: MusicalKey | null): string {
  const index = key?.pitch_classes.indexOf(pitch % 12) ?? -1;
  if (key && index >= 0) {
    const name = key.scale_names[index], naturals: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const alteration = [...name.slice(1)].reduce((sum, value) => sum + (value === "#" ? 1 : -1), 0);
    return `${name.replaceAll("#", "♯").replaceAll("b", "♭")}${Math.floor((pitch - naturals[name[0]] - alteration) / 12) - 1}`;
  }
  return `${["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}
