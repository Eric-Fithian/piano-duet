import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { measureLandings, summarizeFluency } from "../../src/core/reading-fluency.ts";
import type { LandingChange, PositionChange } from "../../src/core/reading-fluency.ts";
import type { TimedObservation, TimingContext } from "../../src/core/reading-timing.ts";

test("landing and fluency calculations match Python with exclusions and outliers", () => {
  const changes: LandingChange[] = Array.from({ length: 96 }, (_, index) => ({ index, clef: index % 2 ? "treble" : "bass",
    pitch: index % 4 ? 60 : 62, finger: index % 3 ? 2 : null, shift_steps: index % 2 ? 2 : -2,
    extra_seconds: index % 11 === 0 ? null : index === 33 ? 4.5 : 0.1 + (index % 4) / 10,
    extra_beats: index % 11 === 0 ? null : index === 33 ? 6 : 0.2 + (index % 4) / 10,
    bpm: index % 11 === 0 ? null : 60 + index % 5,
    arrival_seconds: index % 13 === 0 ? null : index === 33 ? 6 : 0.5 + (index % 4) / 10, arrival_reason: null }));
  const histories = [[], changes.slice(0, 4), changes.slice(0, 10), changes.slice(0, 23), changes];
  const observations: TimedObservation[] = Array.from({ length: 10 }, (_, index) => ({ index, start: index, heard_at: index === 7 ? 20 : index * 0.8,
    group: index, confidence: index === 4 ? 0.7 : 0.95, matched: true }));
  const positions: PositionChange[] = [1, 4, 6, 7, 8].map((index) => ({ index, clef: "treble", pitch: 60 + index,
    finger: 2, shift_steps: 2, extra_seconds: null, extra_beats: null, bpm: null }));
  const contexts: (TimingContext & { introduction?: boolean })[] = [
    {}, { introduction: true, reading_timing: { interruptions: [] } },
    { reading_timing: { interruptions: [6] } }, { reading_timing: { interruptions: [] } },
  ];
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.reading_curriculum import measure_landings, summarize_fluency
histories, positions, observations, contexts = json.loads(sys.stdin.readline())
print(json.dumps({"summaries": [summarize_fluency(rows) for rows in histories], "landings": [measure_landings(positions, observations, context) for context in contexts]}))
`], { input: JSON.stringify([histories, positions, observations, contexts]) + "\n", encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  assert.deepEqual(histories.map(summarizeFluency), expected.summaries);
  assert.deepEqual(contexts.map((context) => measureLandings(positions, observations, context)), expected.landings);
});
