import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeBar } from "../../src/core/reading-bar.ts";
import type { AttackStage } from "../../src/core/reading-bar.ts";
import type { ReadingHand, ReadingLine, ReadingNote } from "../../src/core/reading-line.ts";
import type { MusicalKey } from "../../src/core/musical-key.ts";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

test("reading bars replay Python's phrase options and produce the same notes", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from copy import deepcopy
sys.path.insert(0, "tests")
from piano_duet.key_tracking import MusicalKey
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import plan_line, write_bar
from piano_duet.reading_stages import STAGES
from reading_recording import RecordingPhrase, RecordingRandom
progress = reading_progress([])
cases = []
for stage in STAGES:
    key = MusicalKey(*stage["keys"][-1]).to_dict()
    meter = stage["meters"][-1]
    numerator, denominator = map(int, meter.split("/"))
    beats = numerator * 4 / denominator
    unit = 60 / max(60, stage["tempo"] + 12)
    for staff in ("bass", "treble"):
        low, high = (60, 76 + stage["register"] * 12) if staff == "treble" else (stage["bass_low"] - stage["register"] * 12, 59)
        scale = [p for p in range(low, high + 1) if p % 12 in key["pitch_classes"]]
        events = []
        rng = RecordingRandom(14, events)
        line = plan_line(stage, progress, key, meter, staff, staff, 0, scale, None, [], rng, True, True, False)
        initial = deepcopy(vars(line))
        initial["endings"] = list(initial["endings"].items())
        initial["prefix"] = list(initial["prefix"])
        phrase = RecordingPhrase(rng)
        events.clear()
        notes = []
        write_bar(stage, progress, key, 0, beats, unit, [line], phrase, notes, rng)
        final = dict(vars(line), endings=list(line.endings.items()), prefix=list(line.prefix))
        cases.append({"stage": stage, "hands": progress["hands"], "key": key, "beats": beats, "unit": unit,
            "initial": initial, "final": final, "notes": notes, "events": events})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 50_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  type SerializedLine = Omit<ReadingLine, "endings"> & { endings: [number, number][] };
  const cases: { stage: AttackStage; hands: Record<string, ReadingHand>; key: MusicalKey; beats: number; unit: number;
    initial: SerializedLine; final: SerializedLine; notes: ReadingNote[]; events: ReplayEvent[] }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    const replay = new ReadingReplay(item.events);
    const phrase = { note: (onset: number, pitches: Map<number, number>, durations: Map<number, number>) => replay.note(onset, [...pitches], [...durations]),
      chordChance: (pitches: number[]) => replay.chordChance(pitches) };
    const line: ReadingLine = { ...item.initial, endings: new Map(item.initial.endings) };
    const notes: ReadingNote[] = [];
    await writeBar(item.stage, item.hands, item.key, 0, item.beats, item.unit, [line], phrase, notes, replay);
    assert.deepEqual(notes, item.notes, `${item.stage.id}: ${line.staff}`);
    assert.deepEqual({ ...line, endings: [...line.endings] }, item.final, `${item.stage.id}: ${line.staff}`);
    replay.finish();
  }
});
