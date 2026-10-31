import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalEventStore, LocalJsonValue, LocalPhraseTranscriber } from "../../src/core/local-service.ts";
import type { LocalVariationAnalyzer } from "../../src/core/variation-service.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";

test("Variations idea, empty retry and playback match the Python endpoint", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, tempfile
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from fastapi.testclient import TestClient
import piano_duet.server as server
from piano_duet.key_tracking import KeyTracker
from piano_duet.notes import Note
quality = {'usable': True, 'onset_support': .91, 'supported_fraction': 1, 'note_support': [.91], 'reason': 'fixture'}
takes = [[Note(pitch=p, start=i*.4+.3, duration=.35, velocity=80) for i,p in enumerate(pitches)] for pitches in ((60,64,67), (), (60,65,67))]
original = [[note.model_dump() for note in take] for take in takes]
class Transcriber:
    last_quality = quality
    def transcribe(self, audio, threshold, cancel, on_progress): return takes.pop(0)
def analyze(generator, notes, threshold, cancel, on_note):
    corrected, details = [], []
    for i, note in enumerate(notes):
        start = note.start - notes[0].start
        corrected.append(note.model_copy(update={'start': start}))
        detail = {'index': i, 'start': start, 'played': note.pitch, 'expected': note.pitch, 'corrected': note.pitch, 'probability': .5, 'expected_probability': .5, 'surprise': .5, 'changed': False, 'chord_collision': False}
        details.append(detail)
        on_note(detail, (i+1)/len(notes))
    return corrected, details
server.analyze_phrase = analyze
engine = object.__new__(server.DuetEngine)
engine.transcriber, engine.generator = Transcriber(), SimpleNamespace()
engine.history, engine.session, engine.key_tracker, engine.lesson = [], None, KeyTracker(), None
session = '9cfb60dc-a9f7-4e10-9b04-033934f96d9b'
lesson = '7cfb60dc-a9f7-4e10-9b04-033934f96d9b'
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=lambda: engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        outcomes = []
        for index, stage in enumerate(('idea','repeat','repeat','repeat')):
            attempt = f'5cfb60dc-a9f7-4e10-9b04-033934f96d9{index}'
            response = client.post('/api/respond', params={'mode':'learning','session':session,'lesson':lesson,'stage':stage,'attempt':attempt,'surprise':.95}, content=np.zeros(3200,dtype='<f4').tobytes(), headers={'X-Duet-Client':'1'})
            assert response.status_code == 200, response.text
            saved = client.get(f'/api/attempts/{attempt}')
            outcomes.append({'events': [json.loads(line) for line in response.text.splitlines()], 'saved': saved.json() if saved.status_code == 200 else None})
print(json.dumps({'outcomes': outcomes, 'takes': original}))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout), events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload: LocalJsonValue, id) {
    if (!id) throw new Error("An attempt needs an ID");
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
    events.push(event); return event;
  } };
  let take = 0;
  const transcriber: LocalPhraseTranscriber = { async run() { return { notes: expected.takes[take++], quality: {
    usable: true, onset_support: 0.91, supported_fraction: 1, note_support: [0.91], reason: "fixture" } }; } };
  const analyzer: LocalVariationAnalyzer = { async run(notes, _threshold, _signal, onNote) {
    const origin = notes[0].start;
    const corrected = notes.map((note) => ({ ...note, start: note.start - origin }));
    const analysis = corrected.map((note, index) => ({ index, start: note.start, played: note.pitch, expected: note.pitch, corrected: note.pitch,
      probability: 0.5, expected_probability: 0.5, surprise: 0.5, changed: false, chord_collision: false }));
    analysis.forEach((detail, index) => onNote?.(detail, (index + 1) / notes.length));
    return { notes: corrected, analysis };
  } };
  const service = new LocalService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transcriber, undefined, analyzer);
  const session = "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", lesson = "7cfb60dc-a9f7-4e10-9b04-033934f96d9b";
  for (const [index, stage] of ["idea", "repeat", "repeat", "repeat"].entries()) {
    const attempt = `5cfb60dc-a9f7-4e10-9b04-033934f96d9${index}`;
    const params = new URLSearchParams({ mode: "learning", session, lesson, stage, attempt, surprise: "0.95" });
    const response = await service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer });
    assert.equal(response.status, 200);
    const actualEvents = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type !== "transcribing");
    const referenceEvents = expected.outcomes[index].events.filter((event: { type: string }) => event.type !== "transcribing");
    for (const event of [...actualEvents, ...referenceEvents]) { delete event.transcription_ms; delete event.first_note_ms; delete event.total_ms; }
    assert.deepEqual(actualEvents, referenceEvents);
    const saved = await service.fetch(`/api/attempts/${attempt}`);
    if (expected.outcomes[index].saved) {
      const actual = await saved.json();
      expected.outcomes[index].saved.created_at = actual.created_at;
      assert.deepEqual(actual, expected.outcomes[index].saved);
    } else assert.equal(saved.status, 404);
  }
});

test("cancelling a Variations take releases the service without saving it", async () => {
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload, id) {
    if (!id) throw new Error("An attempt needs an ID");
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
    events.push(event); return event;
  } };
  const transcriber: LocalPhraseTranscriber = { run(_input, signal) {
    return new Promise((_resolve, reject) => {
      if (!signal) throw new Error("Variations needs cancellation");
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  } };
  const analyzer: LocalVariationAnalyzer = { async run() { throw new Error("Cancelled transcription must not analyze"); } };
  const service = new LocalService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transcriber, undefined, analyzer);
  const params = new URLSearchParams({ mode: "learning", session: "9cfb60dc-a9f7-4e10-9b04-033934f96d9b",
    lesson: "7cfb60dc-a9f7-4e10-9b04-033934f96d9b", attempt: "5cfb60dc-a9f7-4e10-9b04-033934f96d90" });
  const audio = new Float32Array(3200), abort = new AbortController();
  const response = await service.fetch(`/api/respond?${params}`, { method: "POST", body: audio.buffer, signal: abort.signal });
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal((await service.fetch(`/api/respond?${params}`, { method: "POST", body: audio.buffer })).status, 409);
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(events.length, 0);
  assert.equal((await (await service.fetch("/api/status")).json()).busy, false);
});
