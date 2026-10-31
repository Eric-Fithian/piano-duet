import { musicalKey } from "./musical-key.ts";
import type { KeyMode, MusicalKey } from "./musical-key.ts";

export type PracticeFamily = "technique" | "reading" | "theory" | "ear" | "repertoire";
export type PracticePurpose = "Explore" | "Check" | "Repair" | "Revisit" | "Extend";
export interface SelectionSkill {
  id: string; level: number | null; accuracy: number | null; challenge: number; attempts: number; last_practiced: number | null;
  conditions: { id: string; accuracy: number | null; attempts: number }[];
}
export interface SelectionAttempt {
  created_at: number; context: { family: string; reveals: number; hints: number; hearings: number };
  assessment: { score: { score: number } | null; evidence: { skill: string; facet: string; value: number }[] };
}
export interface SelectionProfile { skills: SelectionSkill[]; practice_recent: SelectionAttempt[] }

const ANCHORS: [PracticeFamily, string][] = [["technique", "technique.scales"], ["reading", "reading.pitch"],
  ["theory", "theory.chords"], ["ear", "ear.pitch"], ["repertoire", "repertoire.recall"]];
const FIRST_KEYS: [number, KeyMode][] = [[0, "major"], [7, "major"], [5, "major"], [9, "minor"], [2, "major"],
  [4, "minor"], [10, "major"], [2, "minor"], [9, "major"], [3, "major"]];
const KEY_ORDER: [number, KeyMode][] = [...FIRST_KEYS, ...(["major", "minor"] as const).flatMap((mode) =>
  Array.from({ length: 12 }, (_, tonic): [number, KeyMode] => [tonic, mode]).filter(([tonic]) =>
    !FIRST_KEYS.some(([first, firstMode]) => tonic === first && mode === firstMode)))];

export function choosePracticeFocus(profile: SelectionProfile, now: number): [PracticeFamily, PracticePurpose, string] {
  const recent = profile.practice_recent;
  if (!recent.length) return ["technique", "Explore", "A comfortable scale gives us a first look at your playing."];
  const skills = new Map(profile.skills.map((skill) => [skill.id, skill]));
  const skillFor = (anchor: string) => {
    const skill = skills.get(anchor);
    if (!skill) throw new Error(`Missing practice skill ${anchor}`);
    return skill;
  };
  const last = recent[0], family = last.context.family, score = last.assessment.score;
  const same = recent.slice(0, 3).filter((attempt) => attempt.context.family === family).length;
  if (family === "theory" && score && score.score < 80 && last.assessment.evidence.length
      && !last.context.reveals && !last.context.hints && !last.context.hearings) {
    return ["technique", "Check", "Try the same notes with the answer shown. This helps separate remembering the notes from executing them."];
  }
  if (family === "repertoire" && last.assessment.evidence.some((row) => row.skill === "technique.chords" && row.facet === "all" && row.value < 0.8)) {
    return ["technique", "Repair", "Isolate a chord that was difficult in your piece, with its notes shown."];
  }
  if (score && score.score < 80 && last.assessment.evidence.length && same < 3) {
    if (!ANCHORS.some(([focus]) => focus === family)) throw new Error(`Unknown practice family ${family}`);
    return [family as PracticeFamily, "Repair", "Your last attempt suggests a useful place to slow down and focus."];
  }
  for (const [focus, anchor] of ANCHORS) {
    if (!recent.some((attempt) => attempt.context.family === focus) && skillFor(anchor).accuracy === null) {
      return [focus, "Explore", `We have little evidence about your ${focus} yet.`];
    }
  }
  const oldest = ANCHORS.reduce((best, item) => {
    const latest = (focus: PracticeFamily) => Math.max(0, ...recent.filter((attempt) => attempt.context.family === focus).map((attempt) => attempt.created_at));
    return latest(item[0]) < latest(best[0]) ? item : best;
  });
  const skill = skillFor(oldest[1]);
  if (skill.last_practiced && now - skill.last_practiced > 7 * 86400) {
    return [oldest[0], "Revisit", "Return to a skill after a break to see what has stayed with you."];
  }
  return [oldest[0], (skill.accuracy ?? 0) >= 85 ? "Extend" : "Explore", "Keep your practice balanced across skills."];
}

export function selectPracticeKey(skill: SelectionSkill): [MusicalKey, string] {
  const conditions = new Map(skill.conditions.map((row) => [row.id, row]));
  const accessible = !skill.level ? 4 : skill.level === 1 ? 8 : 24;
  const keys = KEY_ORDER.slice(0, accessible).map(([tonic, mode]) => musicalKey(tonic, mode));
  const weak = keys.filter((key) => (conditions.get(`key:${key.signature}`)?.accuracy ?? 100) < 80);
  if (weak.length) {
    const key = weak.reduce((best, candidate) => conditions.get(`key:${candidate.signature}`)!.accuracy! < conditions.get(`key:${best.signature}`)!.accuracy! ? candidate : best);
    return [key, `Focus on ${key.name}, where recent attempts were less accurate.`];
  }
  const key = keys.reduce((best, candidate) => (conditions.get(`key:${candidate.signature}`)?.attempts ?? 0) < (conditions.get(`key:${best.signature}`)?.attempts ?? 0) ? candidate : best);
  return [key, `Explore ${key.name}, which has less practice in this skill.`];
}
