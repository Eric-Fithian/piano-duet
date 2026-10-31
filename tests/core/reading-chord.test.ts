import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildChord } from "../../src/core/reading-chord.ts";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

test("chords replay Python's phrase options and random decisions", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from types import SimpleNamespace
from piano_duet.reading_music import CHORDS, build_chord
from reading_recording import RecordingPhrase, RecordingRandom
cases = []
scale = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79]
for texture, shapes in CHORDS.items():
    for pitch in (60, 67, 74):
        for forced in (False, True):
            for seed in (1, 4, 7):
                events = []
                rng = RecordingRandom(seed, events)
                phrase = RecordingPhrase(rng)
                phrase.note(0, {pitch: 1.0}, {0.5: 1.0})
                events.clear()
                chord = build_chord({"texture": texture}, SimpleNamespace(scale=scale), pitch, 0, 0.5, shapes, forced, phrase, rng)
                cases.append({"texture": texture, "scale": scale, "pitch": pitch, "shapes": shapes, "forced": forced, "events": events, "chord": chord})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { texture: string; scale: number[]; pitch: number; shapes: number[][]; forced: boolean; events: ReplayEvent[]; chord: number[] }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    const replay = new ReadingReplay(item.events);
    const phrase = { note: (onset: number, pitches: Map<number, number>, durations: Map<number, number>) => replay.note(onset, [...pitches], [...durations]),
      chordChance: (pitches: number[]) => replay.chordChance(pitches) };
    assert.deepEqual(await buildChord(item.texture, item.scale, item.pitch, 0, 0.5, item.shapes, item.forced, phrase, replay), item.chord);
    replay.finish();
  }
});
