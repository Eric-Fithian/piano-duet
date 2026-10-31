import { roundEven } from "./numeric.ts";
import { readingProgress } from "./reading-progress.ts";
import type { ProgressAttempt } from "./reading-progress.ts";

const SKILLS: [string, string, string][] = [
  ["technique.accuracy", "Technique", "Note accuracy"], ["technique.evenness", "Technique", "Even timing"],
  ["technique.tempo", "Technique", "Controlled speed"], ["technique.dynamics", "Technique", "Even loudness"],
  ["technique.scales", "Technique", "Scale execution"], ["technique.chords", "Technique", "Chord execution"],
  ["technique.arpeggios", "Technique", "Arpeggio execution"], ["technique.patterns", "Technique", "Finger patterns"],
  ["reading.pitch", "Reading", "Reading pitches"], ["reading.rhythm", "Reading", "Reading rhythm"],
  ["theory.scales", "Theory", "Building scales"], ["theory.chords", "Theory", "Building chords"],
  ["ear.pitch", "Ear", "Playing back pitches by ear"], ["ear.rhythm", "Ear", "Playing back rhythm by ear"],
  ["repertoire.recall", "Repertoire", "Playing from memory"], ["creating.exploration", "Creating", "Musical exploration"],
];
const FAMILIES = ["Technique", "Reading", "Theory", "Ear", "Repertoire", "Creating"];
export interface ProfileEvidence { skill: string; facet: string; label: string; value: number; weight: number; challenge: number }
export interface ProfileAttempt {
  id: string; created_at: number; mode: string; excluded: boolean; notes: unknown[];
  context: { source: string; [key: string]: unknown };
  prompt: { family: string; title: string; target: unknown[]; shape?: unknown; reading?: unknown; key?: unknown; [key: string]: unknown };
  assessment: { evidence: ProfileEvidence[]; [key: string]: unknown };
}
type EvidenceRow = ProfileEvidence & { at: number; attempt_id: string };

function summarizeEvidence(rows: EvidenceRow[]) {
  const recent = rows.slice(-12);
  if (!recent.length) return { level: null, accuracy: null, attempts: 0, confidence: "Untested", last_practiced: null, challenge: 1 };
  const total = recent.reduce((sum, row) => sum + row.weight, 0);
  if (!(total > 0)) throw new Error("Evidence requires positive total weight");
  const accuracy = recent.reduce((sum, row) => sum + row.value * row.weight, 0) / total;
  let level = 0;
  for (let challenge = 1; challenge <= 5; challenge++) {
    const qualifying = recent.filter((row) => row.challenge >= challenge);
    if (qualifying.filter((row) => row.value >= 0.85).length >= 3) {
      const weight = qualifying.reduce((sum, row) => sum + row.weight, 0);
      if (!(weight > 0)) throw new Error("Evidence requires positive total weight");
      if (qualifying.reduce((sum, row) => sum + row.value * row.weight, 0) / weight >= 0.85) level = challenge;
    }
  }
  return { level, accuracy: roundEven(100 * accuracy), attempts: rows.length,
    confidence: recent.length < 6 ? "Developing" : "Repeated evidence", last_practiced: rows.at(-1)!.at,
    challenge: Math.max(...recent.map((row) => row.challenge)) };
}

function attemptSummary(attempt: ProfileAttempt) {
  return { id: attempt.id, created_at: attempt.created_at, mode: attempt.mode, excluded: attempt.excluded,
    title: attempt.prompt.title, shape: attempt.prompt.shape ?? null, reading: attempt.prompt.reading ?? null,
    key: attempt.prompt.key ?? null, note_count: attempt.notes.length, assessment: attempt.assessment, context: attempt.context };
}

export function learnerProfile(attempts: ProfileAttempt[], now = Date.now() / 1000) {
  const skills = new Map<string, EvidenceRow[]>();
  const facets = new Map<string, Map<string, EvidenceRow[]>>();
  const userAttempts = attempts.filter((attempt) => attempt.context.source === "microphone");
  const included = userAttempts.filter((attempt) => !attempt.excluded);
  for (const attempt of included) for (const evidence of attempt.assessment.evidence) {
    const item = { ...evidence, at: attempt.created_at, attempt_id: attempt.id };
    if (evidence.facet === "all") {
      const rows = skills.get(evidence.skill) ?? [];
      rows.push(item); skills.set(evidence.skill, rows);
    } else {
      const conditions = facets.get(evidence.skill) ?? new Map<string, EvidenceRow[]>();
      const rows = conditions.get(evidence.facet) ?? [];
      rows.push(item); conditions.set(evidence.facet, rows); facets.set(evidence.skill, conditions);
    }
  }
  const catalog = SKILLS.map(([id, family, label]) => {
    const conditions = [...(facets.get(id) ?? new Map<string, EvidenceRow[]>())].map(([facet, rows]) =>
      ({ id: facet, label: rows.at(-1)!.label, ...summarizeEvidence(rows) }));
    conditions.sort((a, b) => a.accuracy! - b.accuracy! || a.attempts - b.attempts || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return { id, family, label, ...summarizeEvidence(skills.get(id) ?? []), conditions,
      coverage: { keys: conditions.filter((row) => row.id.startsWith("key:")).length,
        pitches: conditions.filter((row) => row.id.startsWith("pitch:")).length } };
  });
  const date = (timestamp: number) => {
    const value = new Date(timestamp * 1000);
    if (!Number.isFinite(value.valueOf())) throw new Error("Invalid attempt timestamp");
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  };
  const readingAttempts = attempts.filter((attempt) => attempt.prompt.family === "reading") as unknown as ProgressAttempt[];
  return { assessment_version: 1, reading: readingProgress(readingAttempts), attempts: userAttempts.length,
    included_attempts: included.length, notes: included.reduce((sum, attempt) => sum + attempt.notes.length, 0),
    days: new Set(included.map((attempt) => date(attempt.created_at))).size, skills: catalog, families: FAMILIES,
    creative_phrases: included.filter((attempt) => ["duet", "learning"].includes(attempt.mode) && !attempt.prompt.target.length && attempt.notes.length).length,
    recent: userAttempts.slice(-20).reverse().map(attemptSummary),
    practice_recent: included.filter((attempt) => attempt.mode === "practice").slice(-20).reverse().map(attemptSummary), generated_at: now };
}
