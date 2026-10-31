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
  cases.push({ prompt: { family: "creating", target: [], challenge: 1, title: "Idea" }, notes: melody, context, quality });
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.assessment import assess
from piano_duet.notes import Note
cases = json.load(sys.stdin)
print(json.dumps([assess(c['prompt'], [Note.model_validate(n) for n in c['notes']], c['context'], c['quality']) for c in cases]))
`], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 10_000_000 });
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
