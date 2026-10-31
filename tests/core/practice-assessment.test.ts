import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assessPractice } from "../../src/core/practice-assessment.ts";
import type { PracticeContext, PracticeNote, PracticePrompt, PracticeQuality } from "../../src/core/practice-assessment.ts";
import { musicalKey } from "../../src/core/musical-key.ts";

test("recorded practice assessments match Python across focuses, assistance, quality and errors", () => {
  const key = musicalKey(0, "major");
  const note = (pitch: number, start: number, velocity = 76): PracticeNote => ({ pitch, start, duration: 0.8, velocity });
  const melody = [note(60, 0), note(62, 1), note(64, 2), note(65, 3), note(67, 4), note(65, 5), note(64, 6)];
  const chord = [note(60, 0), note(64, 0), note(67, 0), note(60, 2), note(64, 2), note(67, 2)];
  const context: PracticeContext = { source: "microphone", notation_visible: true, hearings: 0, reveals: 0, hints: 0, familiar: false };
  const quality: PracticeQuality = { usable: true, reason: "synthetic" };
  const cases: { prompt: PracticePrompt; notes: PracticeNote[]; context: PracticeContext; quality: PracticeQuality }[] = [];
  for (const family of ["technique", "reading", "theory", "ear", "repertoire"]) {
    for (const [target, shape] of [[melody, "scale"], [chord, "chord"]] as const) {
      for (const variant of ["correct", "wrong", "slow", "assisted", "revealed", "heard", "extra", "missing", "uncertain", "demo", "empty"]) {
        const prompt: PracticePrompt = { family, shape, target, challenge: 3, bpm: 60, even: shape === "scale", dynamics: "even", key, title: "Synthetic", piece_id: "piece" };
        const played = target.map((n, i) => ({ ...n, pitch: variant === "wrong" && i === 1 ? n.pitch + 1 : n.pitch,
          start: 1 + n.start * (variant === "slow" ? 1.5 : 1), velocity: 65 + i * 3 }));
        if (variant === "extra") played.push(note(72, 10));
        if (variant === "missing") played.splice(1, 1);
        cases.push({ prompt, notes: variant === "empty" ? [] : played,
          context: { ...context, notation_visible: family !== "repertoire", familiar: family === "repertoire",
            hearings: family === "ear" ? (variant === "heard" ? 2 : 1) : (variant === "heard" ? 1 : 0),
            hints: variant === "assisted" ? 1 : 0, reveals: variant === "revealed" ? 1 : 0, source: variant === "demo" ? "demo" : "microphone" },
          quality: { ...quality, usable: variant !== "uncertain" } });
      }
    }
  }
  let seed = 31;
  const draw = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let index = 0; index < 100; index++) {
    const family = ["technique", "reading", "theory", "ear", "repertoire"][index % 5];
    const target: PracticeNote[] = [];
    for (let attack = 0; attack < 5; attack++) {
      const count = draw() < 0.35 ? 2 : 1;
      for (let i = 0; i < count; i++) target.push(note(48 + Math.floor(draw() * 30), attack * 0.75));
    }
    const played = target.filter(() => draw() > 0.15).map((item) => ({ ...item,
      pitch: draw() < 0.2 ? item.pitch + 1 : item.pitch, start: 1 + item.start * (0.8 + Math.floor(draw() * 4) / 5),
      velocity: 40 + Math.floor(draw() * 80) })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    cases.push({ prompt: { family, shape: index % 2 ? "scale" : "chord", target, challenge: index % 5 + 1,
      bpm: 76, even: index % 2 === 1, dynamics: "even", key, title: "Synthetic", piece_id: "piece" }, notes: played,
    context: { ...context, notation_visible: index % 3 === 0, familiar: index % 4 === 0,
      hearings: family === "ear" ? index % 3 : 0, reveals: index % 7 === 0 ? 1 : 0, hints: index % 11 === 0 ? 1 : 0 }, quality });
  }
  cases.push({ prompt: { family: "creating", target: [], challenge: 1, title: "Idea" }, notes: melody, context, quality });
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.assessment import assess
from piano_duet.notes import Note
cases = json.load(sys.stdin)
print(json.dumps([assess(c['prompt'], [Note.model_validate(n) for n in c['notes']], c['context'], c['quality']) for c in cases]))
`], { input: JSON.stringify(cases), encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout) as ReturnType<typeof assessPractice>[];
  for (const [index, item] of cases.entries()) {
    const actual = assessPractice(item.prompt, item.notes, item.context, item.quality);
    assert.equal(actual.evidence.length, expected[index].evidence.length);
    for (const [row, evidence] of actual.evidence.entries()) {
      assert.ok(Math.abs(evidence.value - expected[index].evidence[row].value) < 1e-12, `evidence ${row} in case ${index}`);
      evidence.value = expected[index].evidence[row].value;
    }
    assert.deepEqual(actual, expected[index], `case ${index}: ${item.prompt.family}`);
  }
});

test("recorded Reading assessments match Python at every curriculum stage", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, 'tests')
from piano_duet.assessment import assess
from piano_duet.notes import Note
from piano_duet.reading_stages import STAGES
from reading_recording import record_composition
cases = []
for stage in STAGES:
    task = record_composition(stage, 7)['score']
    task['family'] = 'reading'
    for scenario in ('correct', 'wrong', 'assisted'):
        notes = [{k: note[k] for k in ('pitch','start','duration','velocity')} for note in task['target']]
        for note in notes: note['start'] += 1
        if scenario == 'wrong': notes[0]['pitch'] = 21 if notes[0]['pitch'] != 21 else 22
        context = {'source':'microphone','notation_visible':True,'hearings':0,'reveals':0,'hints':int(scenario == 'assisted'),'familiar':False}
        quality = {'usable':True,'reason':'synthetic'}
        cases.append({'task':task, 'notes':notes, 'context':context, 'quality':quality,
                      'expected':assess(task, [Note.model_validate(note) for note in notes], context, quality)})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 50_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { task: PracticePrompt; notes: PracticeNote[]; context: PracticeContext; quality: PracticeQuality;
    expected: ReturnType<typeof assessPractice> }[] = JSON.parse(reference.stdout);
  assert.equal(cases.length, 72);
  for (const [index, item] of cases.entries()) {
    const actual = assessPractice(item.task, item.notes, item.context, item.quality);
    assert.equal(actual.evidence.length, item.expected.evidence.length);
    for (const [row, evidence] of actual.evidence.entries()) {
      assert.ok(Math.abs(evidence.value - item.expected.evidence[row].value) < 1e-12, `evidence ${row} in case ${index}`);
      evidence.value = item.expected.evidence[row].value;
    }
    assert.deepEqual(actual, item.expected, `case ${index}`);
  }
});
