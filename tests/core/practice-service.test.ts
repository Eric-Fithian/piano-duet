import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalEventStore, LocalJsonValue, LocalPhraseTranscriber } from "../../src/core/local-service.ts";
import type { PracticeNote } from "../../src/core/practice-assessment.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";

test("guided recorded practice matches FastAPI and survives service reload", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, tempfile
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from fastapi.testclient import TestClient
import piano_duet.server as server
from piano_duet.notes import Note
quality = {'usable':True,'onset_support':0.95,'supported_fraction':1,'note_support':[0.95]*15,'reason':'synthetic'}
class Transcriber:
    last_quality = quality
    notes = []
    def transcribe(self, audio, threshold, cancel, on_progress): return self.notes
engine = SimpleNamespace(transcriber=Transcriber(), generator=SimpleNamespace(phrase=None))
session = '9cfb60dc-a9f7-4e10-9b04-033934f96d9b'
attempt = '5cfb60dc-a9f7-4e10-9b04-033934f96d90'
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=lambda: engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        task = client.post('/api/practice/next', json={'focus':'guided'}, headers={'X-Duet-Client':'1'}).json()
        engine.transcriber.notes = [Note.model_validate(n) for n in task['target']]
        response = client.post('/api/respond', params={'mode':'practice','session':session,'task':task['id'],'attempt':attempt}, content=np.zeros(3200,dtype='<f4').tobytes(), headers={'X-Duet-Client':'1'})
        assert response.status_code == 200, response.text
        events = [json.loads(line) for line in response.text.splitlines()]
        saved = client.get('/api/attempts/' + attempt).json()
        profile = client.get('/api/profile').json()
print(json.dumps({'task':task,'events':events,'saved':saved,'profile':profile}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload: LocalJsonValue, id) {
    if (!id) throw new Error("Expected an explicit event ID");
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z" };
    events.push(event); return event;
  } };
  let notes: PracticeNote[] = [];
  const quality = { usable: true, onset_support: 0.95, supported_fraction: 1, note_support: Array(15).fill(0.95), reason: "synthetic" };
  const transcriber: LocalPhraseTranscriber = { async run(input) { assert.equal(input.audio.length, 3200); return { notes, quality }; } };
  let service = new LocalService(store, undefined, () => 1704067200, undefined, undefined, undefined, undefined, undefined, transcriber);
  const task = await (await service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify({ focus: "guided" }) })).json();
  expected.task.id = task.id;
  assert.deepEqual(task, expected.task);
  notes = task.target;
  const session = "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", attempt = "5cfb60dc-a9f7-4e10-9b04-033934f96d90";
  const params = new URLSearchParams({ mode: "practice", session, task: task.id, attempt });
  const response = await service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer });
  assert.equal(response.status, 200);
  const actualEvents = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type !== "transcribing");
  const expectedEvents = expected.events.filter((event: { type: string }) => event.type !== "transcribing");
  for (const event of [...actualEvents, ...expectedEvents]) if (event.type === "heard") delete event.transcription_ms;
  assert.deepEqual(actualEvents, expectedEvents);
  service = new LocalService(store, undefined, () => 1704067200, undefined, undefined, undefined, undefined, undefined, transcriber);
  const saved = await (await service.fetch(`/api/attempts/${attempt}`)).json();
  expected.saved.created_at = saved.created_at; expected.saved.prompt.id = task.id;
  assert.deepEqual(saved, expected.saved);
  const profile = await (await service.fetch("/api/profile")).json();
  expected.profile.generated_at = profile.generated_at;
  for (const skill of expected.profile.skills) {
    if (skill.last_practiced) skill.last_practiced = 1704067200;
    for (const condition of skill.conditions) if (condition.last_practiced) condition.last_practiced = 1704067200;
  }
  for (const row of [...expected.profile.recent, ...expected.profile.practice_recent]) row.created_at = 1704067200;
  assert.deepEqual(profile, expected.profile);
});

test("ordinary reading selection replays the Python composer", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient
sys.path.insert(0, 'tests')
from reading_recording import RecordingPhrase, RecordingRandom
import piano_duet.server as server
events = []
original = server.next_task
def recorded(*args):
    args = list(args); args[2] = RecordingRandom(3, events)
    return original(*args)
server.next_task = recorded
class Engine:
    def __init__(self): self.generator = SimpleNamespace(phrase=RecordingPhrase)
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=Engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        response = client.post('/api/practice/next', json={'focus':'reading'}, headers={'X-Duet-Client':'1'})
        assert response.status_code == 200, response.text
        task = response.json()
print(json.dumps({'task':task, 'events':events}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const { ReadingReplay } = await import("./reading-replay.ts");
  const replay = new ReadingReplay(expected.events);
  const service = new LocalService({ async list() { return []; } }, undefined, () => 1000000, undefined, replay, (context) => {
    replay.phrase(context as never);
    return { note: (onset, pitches, durations) => replay.note(onset, [...pitches], [...durations]), chordChance: (pitches) => replay.chordChance(pitches) };
  });
  const response = await service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify({ focus: "reading" }) });
  assert.equal(response.status, 200);
  const task = await response.json(); expected.task.id = task.id;
  assert.deepEqual(task, expected.task);
  replay.finish();
});
