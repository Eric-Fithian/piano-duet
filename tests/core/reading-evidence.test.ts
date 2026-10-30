import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readingRows, summarizeReading } from "../../src/core/reading-evidence.ts";
import type { ReadingEvidencePrompt, ReadingObservation, ReadingSample } from "../../src/core/reading-evidence.ts";

test("reading evidence and recent readiness match the Python curriculum", () => {
  const cases: { prompt: ReadingEvidencePrompt; observations: ReadingObservation[] }[] = [];
  for (const clef of ["treble", "bass", "grand", undefined]) {
    for (const segments of [[0], [0, 4, 8], [0, 1, 2, 3]]) {
      const observations = Array.from({ length: 12 }, (_, index) => ({ index, expected: 48 + (index * 7) % 31, matched: index % 4 !== 0 }));
      cases.push({
        prompt: { reading: { clef, segments }, target: observations.map((_, index) => ({ staff: index % 3 === 0 ? "bass" : null })) },
        observations,
      });
    }
  }
  const rows = cases.flatMap(({ prompt, observations }, attempt) => readingRows(prompt, observations).map((row) => ({ ...row, attempt })));
  const histories: ReadingSample[][] = [[], ...[1, 5, 6, 16, 31, 32, 33, 100].map((size) => rows.slice(0, size)), rows.map((row) => ({ ...row, value: 1 }))];
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.reading_curriculum import reading_rows, summarize
cases, histories = json.loads(sys.stdin.readline())
print(json.dumps({"rows": [list(reading_rows(case["prompt"], case["observations"])) for case in cases], "summaries": [summarize(rows) for rows in histories]}))
`], { input: JSON.stringify([cases, histories]) + "\n", encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  assert.deepEqual(cases.map(({ prompt, observations }) => readingRows(prompt, observations)), expected.rows);
  assert.deepEqual(histories.map(summarizeReading), expected.summaries);
});
