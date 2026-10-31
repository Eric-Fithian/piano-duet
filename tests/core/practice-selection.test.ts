import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { choosePracticeFocus, selectPracticeKey } from "../../src/core/practice-selection.ts";
import type { SelectionAttempt, SelectionProfile, SelectionSkill } from "../../src/core/practice-selection.ts";

test("guided focus and key selection match Python across histories and skill levels", () => {
  const ids = ["technique.scales", "reading.pitch", "theory.chords", "ear.pitch", "repertoire.recall"];
  const skills = ids.map((id): SelectionSkill => ({ id, level: null, accuracy: null, challenge: 1, attempts: 0, last_practiced: null, conditions: [] }));
  const attempt = (family: string, score: number, at: number): SelectionAttempt => ({ created_at: at,
    context: { family, hearings: 0, reveals: 0, hints: 0 },
    assessment: { score: { score }, evidence: [{ skill: "theory.chords", facet: "all", value: 0.4 }] } });
  const histories: SelectionProfile[] = [{ skills, practice_recent: [] }];
  for (const family of ["technique", "reading", "theory", "ear", "repertoire"]) {
    for (const score of [50, 100]) {
      const first = attempt(family, score, 1000000);
      histories.push({ skills, practice_recent: [first] });
      histories.push({ skills, practice_recent: [first, first, first] });
      histories.push({ skills, practice_recent: [{ ...first, context: { ...first.context, hints: 1 } }] });
    }
  }
  const chordAttempt = attempt("repertoire", 100, 1000000);
  chordAttempt.assessment.evidence = [{ skill: "technique.chords", facet: "all", value: 0.3 }];
  histories.push({ skills, practice_recent: [chordAttempt] });
  const allFamilies = ["technique", "reading", "theory", "ear", "repertoire"].map((family, i) => attempt(family, 90, 1000000 - i * 100));
  for (const accuracy of [60, 90]) for (const last of [100, 999999]) {
    histories.push({ skills: skills.map((skill) => ({ ...skill, accuracy, last_practiced: last })), practice_recent: allFamilies });
  }
  const keys: SelectionSkill[] = [];
  for (const level of [null, 0, 1, 2, 5]) {
    keys.push({ ...skills[0], level });
    keys.push({ ...skills[0], level, conditions: [{ id: "key:C", accuracy: 60, attempts: 4 }, { id: "key:G", accuracy: 40, attempts: 2 }] });
    keys.push({ ...skills[0], level, conditions: [{ id: "key:C", accuracy: 90, attempts: 4 }, { id: "key:G", accuracy: 90, attempts: 2 }] });
  }
  const now = 1000000;
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from unittest.mock import patch
from piano_duet.practice import choose_focus, select_key
case = json.load(sys.stdin)
with patch('piano_duet.practice.time.time', return_value=case['now']):
    print(json.dumps({'focuses': [choose_focus(p) for p in case['histories']], 'keys': [select_key(s) for s in case['keys']]}))
`], { input: JSON.stringify({ histories, keys, now }), encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  assert.deepEqual(histories.map((profile) => choosePracticeFocus(profile, now)), expected.focuses);
  assert.deepEqual(keys.map(selectPracticeKey), expected.keys);
});
