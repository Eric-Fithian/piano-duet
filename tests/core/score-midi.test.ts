import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseMidi } from "../../src/core/score-midi.ts";

test("MIDI score parsing matches Python across synthetic performances", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import base64, io, json, random, sys
import mido
from piano_duet.score_import import parse_midi
sys.path.insert(0, 'tests')
from test_library import two_hand_midi
rng = random.Random(2024)
files = [two_hand_midi()]
for seed in range(35):
    midi = mido.MidiFile(type=1, ticks_per_beat=(120, 240, 480)[seed % 3])
    meta = mido.MidiTrack()
    midi.tracks.append(meta)
    meta.append(mido.MetaMessage('set_tempo', tempo=500000 + seed * 1000))
    meta.append(mido.MetaMessage('time_signature', numerator=(3, 4, 6)[seed % 3], denominator=(4, 4, 8)[seed % 3]))
    meta.append(mido.MetaMessage('key_signature', key=('C', 'G', 'F', 'Am')[seed % 4]))
    for track in range(1 + seed % 3):
        events = mido.MidiTrack()
        midi.tracks.append(events)
        for note in range(5 + seed % 9):
            pitch = rng.randrange(36 + 12 * track, 57 + 12 * track)
            velocity = rng.randrange(30, 120)
            events.append(mido.Message('note_on', note=pitch, velocity=velocity, time=rng.randrange(0, 96)))
            events.append(mido.Message('note_off', note=pitch, time=rng.randrange(24, 480)))
    output = io.BytesIO()
    midi.save(file=output)
    files.append(output.getvalue())
print(json.dumps([{'midi': base64.b64encode(data).decode(), 'parsed': parse_midi(data)} for data in files]))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { midi: string; parsed: unknown }[] = JSON.parse(reference.stdout);
  assert.equal(cases.length, 36);
  for (const item of cases) assert.deepEqual(parseMidi(Buffer.from(item.midi, "base64")), item.parsed);
  assert.throws(() => parseMidi(Buffer.from("nope")), { message: "This is not a standard MIDI file" });
  assert.throws(() => parseMidi(Buffer.from("MThd")), { message: "The MIDI file is truncated" });
});
