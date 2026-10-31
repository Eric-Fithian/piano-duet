import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chooseContext } from "../../src/core/reading-context.ts";
import type { ContextProgress, ContextStage } from "../../src/core/reading-context.ts";
import { musicalKey } from "../../src/core/musical-key.ts";
import type { KeyMode, MusicalKey } from "../../src/core/musical-key.ts";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

type RecordingCase = { stage: ContextStage; progress: ContextProgress; events: ReplayEvent[];
  score: { reading: { clef: string }; key: MusicalKey; meter: string } };
let recordedCases: RecordingCase[] | undefined;

function recordings(): RecordingCase[] {
  if (!recordedCases) {
    const reference = spawnSync("uv", ["run", "--frozen", "python", "tests/reading_recording.py"], { encoding: "utf8", maxBuffer: 20_000_000 });
    assert.equal(reference.status, 0, reference.stderr);
    recordedCases = JSON.parse(reference.stdout) as RecordingCase[];
  }
  return recordedCases;
}

test("all 24 musical keys match the Python reference", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
from piano_duet.key_tracking import MusicalKey
print(json.dumps([MusicalKey(tonic, mode).to_dict() for mode in ("major", "minor") for tonic in range(12)]))
`], { encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  const expected: MusicalKey[] = JSON.parse(reference.stdout);
  assert.deepEqual((["major", "minor"] as KeyMode[]).flatMap((mode) => Array.from({ length: 12 }, (_, tonic) => musicalKey(tonic, mode))), expected);
});

test("reading contexts offer the same choices and select the Python result for each stage", () => {
  for (const { stage, progress, events, score } of recordings()) {
    const replay = new ReadingReplay(events.slice(0, 3));
    assert.deepEqual(chooseContext(stage, progress, replay), [score.reading.clef, score.key, score.meter], stage.id);
    replay.finish();
  }
});

test("context selection balances prior practice and unfamiliar signatures", () => {
  const inputs = recordings().filter((_, index) => index % 2 === 0).map(({ stage, progress }) => {
    const path = progress.curriculum.path.map((entry) => entry.id === stage.id
      ? { ...entry, groups: entry.groups.map((group, index) => ({ ...group, ready: index === 0 })) } : entry);
    return { stage, progress: { curriculum: { ...progress.curriculum, path,
      demonstrated_keys: ["C", "Am"], contexts: [
        { clef: "treble", key: "C", meter: "4/4", samples: 8 },
        { clef: "bass", key: "Am", meter: "3/4", samples: 2 },
      ] } } };
  });
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.reading_music import choose_context
from reading_recording import RecordingRandom
cases = json.loads(sys.stdin.readline())
result = []
for item in cases:
    events = []
    context = choose_context(item["stage"], item["progress"], RecordingRandom(13, events))
    result.append({"events": events, "context": context})
print(json.dumps(result))
`], { input: JSON.stringify(inputs) + "\n", encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  const expected: { events: ReplayEvent[]; context: [string, MusicalKey, string] }[] = JSON.parse(reference.stdout);
  inputs.forEach(({ stage, progress }, index) => {
    const replay = new ReadingReplay(expected[index].events);
    assert.deepEqual(chooseContext(stage, progress, replay), expected[index].context, stage.id);
    replay.finish();
  });
});
