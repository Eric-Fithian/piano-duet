import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { stageRequirements } from "../../src/core/reading-stage-requirements.ts";
import type { StageRecord, StageRequirementsInput } from "../../src/core/reading-stage-requirements.ts";

test("stage requirements match the Python curriculum for varied histories", () => {
  const vocabularies = {
    treble: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76],
    bass: [48, 50, 52, 53, 55, 57, 59],
    grand: [48, 60, 64],
  };
  const histories: StageRecord[][] = [[]];
  for (const length of [2, 6, 18, 30, 60]) {
    for (const quality of ["perfect", "mixed", "untimed"]) {
      histories.push(Array.from({ length }, (_, index) => {
        const clef = (["treble", "bass", "grand"] as const)[index % 3];
        const pitches = vocabularies[clef];
        return {
          clef,
          key: ["C", "G", "F", "A minor"][index % 4],
          meter: ["4/4", "3/4", "6/8"][index % 3],
          pitches,
          pitch_values: pitches.map((_, note) => quality === "mixed" && (index + note) % 5 === 0 ? 0 : 1),
          rhythm: { accuracy: quality === "untimed" ? null : quality === "mixed" ? 70 : 90, bpm: quality === "untimed" ? null : 72 },
        };
      }));
    }
  }
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.reading_stages import STAGES, stage_requirements
histories = json.loads(sys.stdin.readline())
print(json.dumps({"stages": STAGES, "results": [[stage_requirements(stage, rows) for rows in histories] for stage in STAGES]}))
`], { input: JSON.stringify(histories) + "\n", encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  const expected: { stages: StageRequirementsInput[]; results: unknown[][] } = JSON.parse(reference.stdout);
  for (const [index, stage] of expected.stages.entries()) {
    assert.deepEqual(histories.map((history) => stageRequirements(stage, history)), expected.results[index], stage.id);
  }
});
