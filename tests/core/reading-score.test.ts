import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readingAttacks, staffStep } from "../../src/core/reading-score.ts";
import type { MusicalKey } from "../../src/core/musical-key.ts";

test("staff positions and score attacks match Python for all keys and composed scores", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.key_tracking import MusicalKey
from piano_duet.reading_music import reading_attacks, staff_step
from piano_duet.reading_stages import STAGES
from reading_recording import record_composition
keys = [MusicalKey(tonic, mode).to_dict() for mode in ("major", "minor") for tonic in range(12)]
steps = [{"key": key, "pitches": [pitch for pitch in range(21, 109) if pitch % 12 in key["pitch_classes"]]} for key in keys]
for item in steps:
    item["values"] = [staff_step(pitch, item["key"]) for pitch in item["pitches"]]
scores = [record_composition(stage, 0)["score"]["target"] for stage in STAGES]
print(json.dumps({"steps": steps, "scores": scores, "attacks": [reading_attacks(score) for score in scores]}))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected: { steps: { key: MusicalKey; pitches: number[]; values: number[] }[];
    scores: { start: number }[][]; attacks: { start: number; indices: number[] }[][] } = JSON.parse(reference.stdout);
  for (const { key, pitches, values } of expected.steps) assert.deepEqual(pitches.map((pitch) => staffStep(pitch, key)), values, key.name);
  assert.deepEqual(expected.scores.map(readingAttacks), expected.attacks);
});
