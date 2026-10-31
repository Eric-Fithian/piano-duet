import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { recordingEvents, recordingFrames, RecordingAssembler, RECORDING_STEP } from "../../src/core/recording-segments.ts";
import type { RecordingEvent } from "../../src/core/recording-segments.ts";
import type { RecordingInterval } from "../../src/core/recording-intervals.ts";

test("recording frames, note attributes and segment stitching match Transkun", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import hashlib, json
from types import SimpleNamespace
import numpy as np, torch
from transkun.Data import Note
from transkun.ModelTransformer import TransKun
from transkun.Util import makeFrame
from piano_duet.recording_transcription import to_notes

audio = ((np.arange(44100) % 127 - 63) / 64).astype("<f4")
padded = torch.nn.functional.pad(torch.from_numpy(audio[None, :]), (352800, 352800))
hashes = []
for offset in range(0, len(audio) + 2 * 352800, 353280):
    segment = padded[:, offset:offset + 705600]
    segment = torch.nn.functional.pad(segment, (0, 705600 - segment.shape[-1]))
    hashes.append(hashlib.sha256(makeFrame(segment, 1024, 4096).numpy().tobytes()).hexdigest())
paths = [[] for _ in range(90)]
paths[0] = [(0, 2), (5, 9)]
paths[2] = [(0, 0), (100, 101), (689, 690)]
paths[41] = [(12, 13), (21, 24)]
paths[89] = [(688, 689)]
count = sum(map(len, paths))
generator = torch.Generator().manual_seed(14)
velocity = torch.randn((count, 128), generator=generator)
timing = torch.randn((count, 4), generator=generator)
timing[0, 0], timing[1, 1] = 0, 0.001
ctx = torch.zeros((count, 256))
fake = SimpleNamespace(targetMIDIPitch=[-64, -67] + list(range(21, 109)), hopSize=1024, fs=44100,
    processFramesBatch=lambda frames: (SimpleNamespace(decode=lambda **kwargs: paths), None),
    fetchIntervalFeaturesBatch=lambda context, intervals: (ctx, ctx, None, None),
    velocityPredictor=lambda values: velocity, refinedOFPredictor=lambda values: timing)
(events,), last = TransKun.transcribeFrames(fake, torch.zeros((1, 1, 691, 1)), lastFrameIdx=689)

segments = [
    [Note(8.1, 8.7, 60, 80, True, False), Note(8.2, 8.5, 64, 70, True, True),
     Note(8.25, 8.8, 67, 71, True, False), Note(8.9, 9.1, 67, 72, True, True)],
    [Note(0.15, 1.2, 60, 80, False, True), Note(0.25, 0.9, 64, 73, True, False),
     Note(4, 4.5, 72, 40, False, True)],
    [Note(0, 0.5, 75, 60, True, True)],
]
segment_data = [[vars(event).copy() for event in items] for items in segments]
positions = []
class Assembler:
    fs = 44100
    hopSize = 1024
    windowSize = 4096
    segmentSizeInSecond = 16
    segmentHopSizeInSecond = 8
    targetMIDIPitch = [-64, -67] + list(range(21, 109))
    def transcribeFrames(self, frames, **kwargs):
        positions.append(kwargs["forcedStartPos"])
        index = len(positions) - 1
        return [segments[index]], [350 + index] * 90
result = TransKun.transcribe(Assembler(), torch.zeros((8 * 44100, 1)))
notes = [note.model_dump() for note in to_notes(result, 8)]
print(json.dumps({"hashes": hashes, "paths": paths, "velocity": velocity.flatten().tolist(), "timing": timing.flatten().tolist(),
    "events": [vars(event) for event in events], "last": last, "segments": segment_data, "positions": positions, "notes": notes}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected: { hashes: string[]; paths: RecordingInterval[][]; velocity: number[]; timing: number[]; events: RecordingEvent[];
    last: number[]; segments: RecordingEvent[][]; positions: number[][]; notes: { pitch: number; start: number; duration: number; velocity: number }[] } = JSON.parse(reference.stdout);
  const audio = Float32Array.from({ length: 44100 }, (_, index) => (index % 127 - 63) / 64);
  const hashes: string[] = [];
  for (let offset = 0; offset < audio.length + 2 * 352800; offset += RECORDING_STEP) {
    const frames = recordingFrames(audio, offset);
    hashes.push(createHash("sha256").update(new Uint8Array(frames.buffer)).digest("hex"));
  }
  assert.deepEqual(hashes, expected.hashes);
  const output = recordingEvents(expected.paths, Float32Array.from(expected.velocity), Float32Array.from(expected.timing));
  assert.deepEqual(output.lastPositions, expected.last);
  assert.equal(output.events.length, expected.events.length);
  for (const [index, event] of output.events.entries()) {
    const target = expected.events[index];
    assert.deepEqual([event.pitch, event.velocity, event.hasOnset, event.hasOffset], [target.pitch, target.velocity, target.hasOnset, target.hasOffset]);
    assert.ok(Math.abs(event.start - target.start) < 0.00002 && Math.abs(event.end - target.end) < 0.00002, JSON.stringify({ event, target }));
  }
  const assembler = new RecordingAssembler(8 * 44100);
  expected.segments.forEach((events, index) => {
    assert.deepEqual(assembler.positions, expected.positions[index]);
    assembler.accept(index * RECORDING_STEP, { events, lastPositions: Array(90).fill(350 + index) });
  });
  const notes = assembler.finish();
  assert.equal(notes.length, expected.notes.length);
  for (const [index, note] of notes.entries()) {
    const target = expected.notes[index];
    assert.deepEqual([note.pitch, note.velocity], [target.pitch, target.velocity]);
    assert.ok(Math.abs(note.start - target.start) < 1e-9 && Math.abs(note.duration - target.duration) < 1e-9);
  }
});

test("completed recording notes remain a prefix after later segments stitch open notes", () => {
  const assembler = new RecordingAssembler(30 * 44100);
  const event = (pitch: number, start: number, end: number, hasOnset = true, hasOffset = true): RecordingEvent =>
    ({ pitch, start, end, velocity: 80, hasOnset, hasOffset });
  const positions = Array(90).fill(0);
  assembler.accept(0, { events: [event(60, 8.1, 8.4), event(62, 10, 16, true, false), event(64, 11, 11.3)], lastPositions: positions });
  assert.deepEqual(assembler.completedBefore(RECORDING_STEP), []);
  assembler.accept(RECORDING_STEP, { events: [event(62, 0, 9, false, false)], lastPositions: positions });
  const prefix = assembler.completedBefore(2 * RECORDING_STEP);
  assert.equal(prefix.length, 1);
  assert.equal(prefix[0].pitch, 60);
  assembler.accept(2 * RECORDING_STEP, { events: [event(62, 0, 1.1, false, true), event(67, 0.2, 0.5)], lastPositions: positions });
  assert.deepEqual(assembler.finish().slice(0, prefix.length), prefix);
  assert.deepEqual(assembler.completedBefore(3 * RECORDING_STEP).slice(0, prefix.length), prefix);
});
