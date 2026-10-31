import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { planLine } from "../../src/core/reading-line.ts";
import type { LineStage, ReadingHand, ReadingLine } from "../../src/core/reading-line.ts";
import type { MusicalKey } from "../../src/core/musical-key.ts";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

test("hand-position plans replay Python's options for stages, clefs and keys", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
sys.path.insert(0, "tests")
from piano_duet.key_tracking import MusicalKey
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import plan_line
from piano_duet.reading_stages import STAGES
from reading_recording import RecordingRandom
cases = []
progress = reading_progress([])
for stage in STAGES:
    for tonic, mode in {tuple(stage["keys"][0]), tuple(stage["keys"][-1])}:
        key = MusicalKey(tonic, mode).to_dict()
        for staff in ("bass", "treble"):
            low, high = (60, 76 + stage["register"] * 12) if staff == "treble" else (stage["bass_low"] - stage["register"] * 12, 59)
            scale = [pitch for pitch in range(low, high + 1) if pitch % 12 in key["pitch_classes"]]
            previous = None
            history = []
            for bar in range(2):
                shift = bar == 0
                figure = bar == 1
                accidental = bar == 1
                events = []
                line = plan_line(stage, progress, key, stage["meters"][-1], "grand", staff, bar, scale, previous, history, RecordingRandom(31 + bar, events), shift, figure, accidental)
                result = dict(vars(line), endings=list(line.endings.items()), prefix=list(line.prefix))
                cases.append({"stage": stage, "hands": progress["hands"], "key": key, "meter": stage["meters"][-1], "staff": staff, "bar": bar, "scale": scale, "previous": previous, "history": history, "shift": shift, "figure": figure, "accidental": accidental, "events": events, "result": result})
                previous = scale.index(line.pool[0])
                history = [line.anchor] if line.anchor is not None else []
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 50_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { stage: LineStage; hands: Record<string, ReadingHand>; key: MusicalKey; meter: string; staff: string; bar: number;
    scale: number[]; previous: number | null; history: number[]; shift: boolean; figure: boolean; accidental: boolean;
    events: ReplayEvent[]; result: Omit<ReadingLine, "endings"> & { endings: [number, number][] } }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    const replay = new ReadingReplay(item.events);
    const line = planLine(item.stage, item.hands, item.key, item.meter, "grand", item.staff, item.bar, item.scale,
      item.previous, item.history, replay, item.shift, item.figure, item.accidental);
    assert.deepEqual({ ...line, endings: [...line.endings] }, item.result, `${item.stage.id}: ${item.staff}, bar ${item.bar}, ${item.key.name}`);
    replay.finish();
  }
});
