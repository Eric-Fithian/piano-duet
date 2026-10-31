import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildSong, parseScore, performanceTempo } from "../../src/core/score-build.ts";
import type { ParsedScore } from "../../src/core/score-build.ts";

test("written MIDI and MusicXML become the same songs as Python", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import base64, json, random, sys
from piano_duet.score_import import build_song, parse_score
sys.path.insert(0, 'tests')
from test_library import MUSICXML, two_hand_midi
rng = random.Random(19)
files = [('idea.mid', two_hand_midi()), ('idea.musicxml', MUSICXML.encode())]
sources = [{'filename': name, 'data': base64.b64encode(data).decode(), 'parsed': parse_score(name, data),
            'song': build_song(parse_score(name, data), None, 'Example artist', name)} for name, data in files]
cases = []
for index in range(100):
    notes = []
    for note in range(3 + index % 20):
        notes.append({'pitch': rng.randrange(30, 90), 'beat': rng.randrange(0, 48) / 4,
                      'length': rng.randrange(1, 8) / 4, 'velocity': rng.randrange(30, 120),
                      'staff': rng.choice(['treble', 'bass']), 'voice': rng.randrange(2), 'grace': note == 0 and index % 4 == 0})
    key = [(0, 'major'), (-1, 'minor'), (2, None), None][index % 4]
    parsed = {'notes': notes, 'bpm': rng.randrange(60, 181), 'meters': [(0, ('4/4', '3/4', '6/8')[index % 3])],
              'key': key, 'title': None, 'composer': None, 'pickup': (0, .5, 1)[index % 3]}
    cases.append({'parsed': parsed, 'song': build_song(parsed, None, None, 'synthetic.musicxml')})
print(json.dumps({'sources': sources, 'cases': cases}))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const data: { sources: { filename: string; data: string; parsed: ParsedScore; song: unknown }[];
    cases: { parsed: ParsedScore; song: unknown }[] } = JSON.parse(reference.stdout);
  for (const item of data.sources) {
    const parsed = parseScore(item.filename, Buffer.from(item.data, "base64"));
    assert.deepEqual(parsed, item.parsed);
    assert.deepEqual(buildSong(parsed, null, "Example artist", item.filename), item.song);
  }
  for (const item of data.cases) assert.deepEqual(buildSong(item.parsed, null, null, "synthetic.musicxml"), item.song);
  assert.throws(() => parseScore("score.pdf", new Uint8Array()), { message: "Import a MIDI (.mid) or MusicXML (.musicxml, .xml, .mxl) file" });
});

test("transcribed scores preserve Python tempo, meter, pickup and note-value choices", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
from piano_duet.notes import Note
from piano_duet.score_import import build_song
from piano_duet.score_model import performance_tempo
cases = []
for index in range(40):
    notes = [{'pitch': 48 + i % 20, 'beat': (i * (1 if index % 2 else .125)), 'length': (1 if index % 2 else .125),
              'velocity': 80, 'staff': 'treble' if i % 2 else 'bass', 'voice': 0} for i in range(24)]
    meter = ('4/4', '3/4', '6/8', '4/8')[index % 4]
    meters = [(0, '1/4'), (1, '3/4')] if index % 7 == 0 else [(0, meter)]
    parsed = {'notes': notes, 'bpm': (38, 60, 90, 150, 300)[index % 5], 'meters': meters, 'measures': [0, 1, 4, 7],
              'key': (0, 'major'), 'title': None, 'composer': None, 'pickup': 0}
    played = [Note(pitch=60, start=i * .5, duration=.2, velocity=80) for i in range(24)]
    cases.append({'parsed': parsed, 'song': build_song(parsed, 't', None, 'audio', transcribed=True),
                  'played': [note.model_dump() for note in played], 'tempo': performance_tempo(played, parsed)})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { parsed: ParsedScore; song: unknown; played: { start: number }[]; tempo: number }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    assert.equal(performanceTempo(item.played, item.parsed), item.tempo);
    assert.deepEqual(buildSong(item.parsed, "t", null, "audio", true), item.song);
  }
});
