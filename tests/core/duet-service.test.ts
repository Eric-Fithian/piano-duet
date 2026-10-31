import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalDuetGenerator, LocalEventStore, LocalJsonValue, LocalPhraseTranscriber } from "../../src/core/local-service.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";

test("Duet conversations, history and saved attempts match the Python endpoint", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, tempfile
from pathlib import Path
import numpy as np
from fastapi.testclient import TestClient
import piano_duet.server as server
from piano_duet.key_tracking import KeyTracker
from piano_duet.notes import Note
quality = {'usable': True, 'onset_support': .91, 'supported_fraction': 1, 'note_support': [.91], 'reason': 'fixture'}
takes = [[Note(pitch=p, start=i*.4+.3, duration=.35, velocity=80) for i,p in enumerate(pitches)] for pitches in ((60,64,67), (62,65,69), (), (48,55,60))]
class Transcriber:
    last_quality = quality
    def transcribe(self, audio, threshold, cancel, on_progress):
        return takes.pop(0)
class Generator:
    def __init__(self): self.calls = []
    def generate(self, notes, seconds, temperature, cancel, pitch_classes, tonic, difficulty):
        self.calls.append({'notes': [n.model_dump() for n in notes], 'seconds': seconds, 'temperature': temperature, 'difficulty': difficulty, 'tonic': tonic, 'pitchClasses': list(pitch_classes)})
        return iter([Note(pitch=60+tonic, start=0, duration=.5, velocity=80), Note(pitch=60+tonic, start=.6, duration=.4, velocity=70)])
engine = object.__new__(server.DuetEngine)
engine.transcriber, engine.generator = Transcriber(), Generator()
engine.history, engine.session, engine.key_tracker, engine.lesson = [], None, KeyTracker(), None
sessions = ['9cfb60dc-a9f7-4e10-9b04-033934f96d9b'] * 3 + ['9cfb60dc-a9f7-4e10-9b04-033934f96d9c']
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=lambda: engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        outcomes = []
        for index, session in enumerate(sessions):
            attempt = f'5cfb60dc-a9f7-4e10-9b04-033934f96d9{index}'
            response = client.post('/api/respond', params={'mode':'duet','session':session,'attempt':attempt,'seconds':3,'temperature':.95,'difficulty':3}, content=np.zeros(3200,dtype='<f4').tobytes(), headers={'X-Duet-Client':'1'})
            assert response.status_code == 200, response.text
            outcomes.append({'events': [json.loads(line) for line in response.text.splitlines()], 'saved': client.get(f'/api/attempts/{attempt}').json()})
print(json.dumps({'outcomes': outcomes, 'calls': engine.generator.calls, 'takes': [[{'pitch':p,'start':i*.4+.3,'duration':.35,'velocity':80} for i,p in enumerate(pitches)] for pitches in ((60,64,67),(62,65,69),(),(48,55,60))]}))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload: LocalJsonValue, id) {
    if (!id) throw new Error("An attempt needs an ID");
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
    events.push(event); return event;
  } };
  let take = 0;
  const transcriber: LocalPhraseTranscriber = { async run() { return { notes: expected.takes[take++], quality: {
    usable: true, onset_support: 0.91, supported_fraction: 1, note_support: [0.91], reason: "fixture" } }; } };
  const calls: unknown[] = [];
  const generator: LocalDuetGenerator = { async *generate(input) {
    calls.push(input);
    yield { pitch: 60 + input.tonic, start: 0, duration: 0.5, velocity: 80 };
    yield { pitch: 60 + input.tonic, start: 0.6, duration: 0.4, velocity: 70 };
  } };
  const service = new LocalService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transcriber, generator);
  for (let index = 0; index < 4; index++) {
    const session = `9cfb60dc-a9f7-4e10-9b04-033934f96d9${index === 3 ? "c" : "b"}`;
    const attempt = `5cfb60dc-a9f7-4e10-9b04-033934f96d9${index}`;
    const params = new URLSearchParams({ mode: "duet", session, attempt, seconds: "3", temperature: "0.95", difficulty: "3" });
    const response = await service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer });
    assert.equal(response.status, 200);
    const actualEvents = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type !== "transcribing");
    const referenceEvents = expected.outcomes[index].events.filter((event: { type: string }) => event.type !== "transcribing");
    for (const event of [...actualEvents, ...referenceEvents]) { delete event.transcription_ms; delete event.first_note_ms; delete event.total_ms; }
    assert.deepEqual(actualEvents, referenceEvents);
    const saved = await (await service.fetch(`/api/attempts/${attempt}`)).json();
    expected.outcomes[index].saved.created_at = saved.created_at;
    assert.deepEqual(saved, expected.outcomes[index].saved);
  }
  assert.deepEqual(calls, expected.calls);
});

test("cancelling Duet transcription releases the service without saving an attempt", async () => {
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload, id) {
    if (!id) throw new Error("An attempt needs an ID");
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
    events.push(event); return event;
  } };
  const transcriber: LocalPhraseTranscriber = { run(_input, signal) {
    return new Promise((_resolve, reject) => {
      if (!signal) throw new Error("Duet needs cancellation");
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  } };
  const generator: LocalDuetGenerator = { async *generate() { throw new Error("Cancelled transcription must not generate"); } };
  const service = new LocalService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transcriber, generator);
  const params = new URLSearchParams({ session: "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", attempt: "5cfb60dc-a9f7-4e10-9b04-033934f96d90" });
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
