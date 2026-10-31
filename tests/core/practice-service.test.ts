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
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload: LocalJsonValue, id = crypto.randomUUID()) {
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
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload, id = crypto.randomUUID()) {
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z" };
    events.push(event); return event;
  } };
  const service = new LocalService(store, undefined, () => 1000000, undefined, replay, (context) => {
    replay.phrase(context as never);
    return { note: (onset, pitches, durations) => replay.note(onset, [...pitches], [...durations]), chordChance: (pitches) => replay.chordChance(pitches) };
  });
  const response = await service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify({ focus: "reading" }) });
  assert.equal(response.status, 200);
  const task = await response.json(); expected.task.id = task.id;
  assert.deepEqual(task, expected.task);
  replay.finish();
});

test("a failed theory attempt leads to the Python execution check", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, tempfile
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from fastapi.testclient import TestClient
import piano_duet.server as server
from piano_duet.notes import Note
quality = {'usable':True,'onset_support':0.95,'supported_fraction':1,'note_support':[0.95], 'reason':'synthetic'}
class Transcriber:
    last_quality = quality
    def transcribe(self, audio, threshold, cancel, on_progress): return [Note(pitch=60,start=0,duration=1,velocity=80)]
engine = SimpleNamespace(transcriber=Transcriber(), generator=SimpleNamespace(phrase=None))
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=lambda: engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        headers = {'X-Duet-Client':'1'}
        task = client.post('/api/practice/next', json={'focus':'theory'}, headers=headers).json()
        response = client.post('/api/respond', params={'mode':'practice','session':'9cfb60dc-a9f7-4e10-9b04-033934f96d9b','task':task['id']}, content=np.zeros(3200,dtype='<f4').tobytes(), headers=headers)
        assert response.status_code == 200
        check = client.post('/api/practice/next', json={'focus':'guided'}, headers=headers).json()
print(json.dumps({'task':task,'check':check}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload, id = crypto.randomUUID()) {
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z" };
    events.push(event); return event;
  } };
  const transcriber: LocalPhraseTranscriber = { async run() { return { notes: [{ pitch: 60, start: 0, duration: 1, velocity: 80 }],
    quality: { usable: true, onset_support: 0.95, supported_fraction: 1, note_support: [0.95], reason: "synthetic" } }; } };
  const service = new LocalService(store, undefined, () => 1704067200, undefined, undefined, undefined, undefined, undefined, transcriber);
  const request = (focus: string) => service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify({ focus }) });
  const task = await (await request("theory")).json();
  expected.task.id = task.id;
  assert.deepEqual(task, expected.task);
  const params = new URLSearchParams({ mode: "practice", session: "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", task: task.id });
  const result = await service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer });
  assert.equal(result.status, 200);
  await result.text();
  const check = await (await request("guided")).json();
  expected.check.id = check.id;
  assert.deepEqual(check, expected.check);
  assert.equal(check.purpose, "Check");
});

test("practice request validation matches FastAPI for missing previews and locked stages", async () => {
  const bodies = [
    { focus: "theory", step_by_step: true },
    { focus: "technique", stage: 1 },
    { focus: "reading", stage: 25 },
    { focus: "reading", stage: 2 },
    { focus: "reading", step_by_step: true, after: "9cfb60dc-a9f7-4e10-9b04-033934f96d9b" },
    { focus: "repertoire", piece: "5cfb60dc-a9f7-4e10-9b04-033934f96d90" },
  ];
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient
import piano_duet.server as server
class Engine:
    def __init__(self): self.generator = SimpleNamespace(phrase=None)
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=Engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        results = [client.post('/api/practice/next', json=body, headers={'X-Duet-Client':'1'}) for body in json.load(sys.stdin)]
        output = [{'status':r.status_code, 'body':r.json()} for r in results]
print(json.dumps(output))
`], { input: JSON.stringify(bodies), encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const events: ReadingLogEvent[] = [];
  const service = new LocalService({ async list() { return [...events]; }, async append(kind, payload, id = crypto.randomUUID()) {
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z" };
    events.push(event); return event;
  } });
  for (const [index, body] of bodies.entries()) {
    const response = await service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, expected[index].status);
    const actual = await response.json();
    if (response.status === 422) {
      const locations = (detail: { loc: (string | number)[] }[]) => detail.map((row) => JSON.stringify(row.loc)).sort();
      assert.deepEqual(locations(actual.detail), locations(expected[index].body.detail));
    } else assert.deepEqual(actual, expected[index].body);
  }
});

test("ear practice requires hearing and records aided recall correctly", async () => {
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload, id = crypto.randomUUID()) {
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z" };
    events.push(event); return event;
  } };
  let notes: PracticeNote[] = [];
  const transcriber: LocalPhraseTranscriber = { async run() { return { notes,
    quality: { usable: true, onset_support: 0.95, supported_fraction: 1, note_support: notes.map(() => 0.95), reason: "synthetic" } }; } };
  const service = new LocalService(store, undefined, () => 1704067200, undefined, undefined, undefined, undefined, undefined, transcriber);
  const task = await (await service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify({ focus: "ear" }) })).json();
  const params = new URLSearchParams({ mode: "practice", session: "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", task: task.id });
  const play = () => service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer });
  assert.equal((await play()).status, 400);
  const aid = () => service.fetch(`/api/practice/${task.id}/aid`, { method: "POST", body: JSON.stringify({ kind: "hearings" }) });
  assert.equal((await (await aid()).json()).context.hearings, 1);
  assert.equal((await (await aid()).json()).context.hearings, 2);
  notes = task.target;
  const result = await play();
  assert.equal(result.status, 200);
  const stream = (await result.text()).trim().split("\n").map((line) => JSON.parse(line));
  const assessment = stream.find((event) => event.type === "assessment").assessment;
  assert.equal(assessment.evidence.find((row: { skill: string; facet: string }) => row.skill === "ear.pitch" && row.facet === "all").weight, 0.7);
  assert.equal((await aid()).status, 409);
});

test("a second take cannot save an exercise completed during request processing", async () => {
  const events: ReadingLogEvent[] = [];
  let delay = false, release: (() => void) | undefined, entered: (() => void) | undefined;
  const delayedList = new Promise<void>((resolve) => { entered = resolve; });
  const store: LocalEventStore = { async list() {
    if (delay) { delay = false; await new Promise<void>((resolve) => { release = resolve; entered!(); }); }
    return [...events];
  }, async append(kind, payload, id = crypto.randomUUID()) {
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z" };
    events.push(event); return event;
  } };
  let notes: PracticeNote[] = [];
  const transcriber: LocalPhraseTranscriber = { async run() { return { notes,
    quality: { usable: true, onset_support: 0.95, supported_fraction: 1, note_support: notes.map(() => 0.95), reason: "synthetic" } }; } };
  const service = new LocalService(store, undefined, () => 1704067200, undefined, undefined, undefined, undefined, undefined, transcriber);
  const task = await (await service.fetch("/api/practice/next", { method: "POST", body: "{}" })).json();
  notes = task.target;
  const session = "9cfb60dc-a9f7-4e10-9b04-033934f96d9b";
  const play = (attempt: string) => service.fetch(`/api/respond?${new URLSearchParams({ mode: "practice", session, task: task.id, attempt })}`,
    { method: "POST", body: new Float32Array(3200).buffer });
  delay = true;
  const delayed = play("5cfb60dc-a9f7-4e10-9b04-033934f96d90");
  await delayedList;
  assert.ok(release);
  const first = await play("5cfb60dc-a9f7-4e10-9b04-033934f96d91");
  assert.equal(first.status, 200);
  await first.text();
  release();
  assert.equal((await delayed).status, 409);
  assert.equal(events.filter((event) => event.kind === "attempt").length, 1);
});

test("unfinished tasks and aids survive reload and completed tasks stay closed", async () => {
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload, id = crypto.randomUUID()) {
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z" };
    events.push(event); return event;
  } };
  let notes: PracticeNote[] = [];
  const transcriber: LocalPhraseTranscriber = { async run() { return { notes,
    quality: { usable: true, onset_support: 0.95, supported_fraction: 1, note_support: notes.map(() => 0.95), reason: "synthetic" } }; } };
  const open = () => new LocalService(store, undefined, () => 1704067200, undefined, undefined, undefined, undefined, undefined, transcriber);
  let service = open();
  const task = await (await service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify({ focus: "theory" }) })).json();
  const aid = (kind: string) => service.fetch(`/api/practice/${task.id}/aid`, { method: "POST", body: JSON.stringify({ kind }) });
  assert.equal((await (await aid("reveals")).json()).context.reveals, 1);
  service = open();
  const aided = await (await aid("hints")).json();
  assert.equal(aided.context.reveals, 1);
  assert.equal(aided.context.hints, 1);
  notes = task.target;
  const params = new URLSearchParams({ mode: "practice", session: "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", task: task.id });
  const response = await service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer });
  assert.equal(response.status, 200);
  await response.text();
  service = open();
  assert.equal((await aid("hints")).status, 409);
  assert.equal((await (await service.fetch("/api/profile")).json()).included_attempts, 1);
});

test("repertoire creates a starter piece and remembers a performance after reload", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, tempfile
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from fastapi.testclient import TestClient
import piano_duet.server as server
from piano_duet.notes import Note
quality = {'usable':True,'onset_support':0.95,'supported_fraction':1,'note_support':[0.95]*8,'reason':'synthetic'}
class Transcriber:
    last_quality = quality
    notes = []
    def transcribe(self, audio, threshold, cancel, on_progress): return self.notes
engine = SimpleNamespace(transcriber=Transcriber(), generator=SimpleNamespace(phrase=None))
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=lambda: engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        headers = {'X-Duet-Client':'1'}
        task = client.post('/api/practice/next', json={'focus':'repertoire'}, headers=headers).json()
        engine.transcriber.notes = [Note.model_validate(note) for note in task['target']]
        response = client.post('/api/respond', params={'mode':'practice','session':'9cfb60dc-a9f7-4e10-9b04-033934f96d9b','task':task['id']}, content=np.zeros(3200,dtype='<f4').tobytes(), headers=headers)
        assert response.status_code == 200
        again = client.post('/api/practice/next', json={'focus':'repertoire'}, headers=headers).json()
        pieces = client.get('/api/pieces').json()
print(json.dumps({'task':task,'again':again,'pieces':pieces}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload, id = crypto.randomUUID()) {
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z" };
    events.push(event); return event;
  } };
  let notes: PracticeNote[] = [];
  const transcriber: LocalPhraseTranscriber = { async run() { return { notes,
    quality: { usable: true, onset_support: 0.95, supported_fraction: 1, note_support: notes.map(() => 0.95), reason: "synthetic" } }; } };
  const open = () => new LocalService(store, undefined, () => 1704067200, undefined, undefined, undefined, undefined, undefined, transcriber);
  let service = open();
  const request = () => service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify({ focus: "repertoire" }) });
  const task = await (await request()).json();
  expected.task.id = task.id; expected.task.piece_id = task.piece_id;
  assert.deepEqual(task, expected.task);
  notes = task.target;
  const params = new URLSearchParams({ mode: "practice", session: "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", task: task.id });
  const result = await service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer });
  assert.equal(result.status, 200);
  await result.text();
  service = open();
  const again = await (await request()).json();
  expected.again.id = again.id; expected.again.piece_id = task.piece_id;
  assert.deepEqual(again, expected.again);
  assert.equal(again.context.familiar, true);
  expected.pieces[0].id = task.piece_id;
  assert.deepEqual(await (await service.fetch("/api/pieces")).json(), expected.pieces);
});

test("malformed Practice requests report FastAPI validation locations", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const cases: { method: string; path: string; body?: unknown; audio?: boolean }[] = [
    { method: "POST", path: "/api/practice/next", body: { focus: "bad", stage: 25, after: "bad" } },
    { method: "POST", path: "/api/practice/next", body: { focus: null, step_by_step: "bad", piece: 1 } },
    { method: "POST", path: "/api/practice/next", body: { stage: "no" } },
    { method: "POST", path: `/api/practice/${id}/aid`, body: {} },
    { method: "POST", path: "/api/practice/bad/aid", body: { kind: "bad" } },
    { method: "POST", path: "/api/pieces", body: {} },
    { method: "POST", path: "/api/pieces", body: { attempt: "bad", title: "" } },
    { method: "POST", path: "/api/pieces", body: { attempt: id, title: "x".repeat(81) } },
    { method: "GET", path: "/api/attempts/bad" },
    { method: "POST", path: `/api/attempts/${id}/exclude`, body: {} },
    { method: "POST", path: "/api/attempts/bad/exclude", body: { excluded: "wrong" } },
    { method: "POST", path: "/api/export", body: {} },
    { method: "POST", path: "/api/export", body: { notes: [] } },
    { method: "POST", path: "/api/export", body: { notes: [{ pitch: 20, start: -1, duration: 0, velocity: 128 }] } },
    { method: "POST", path: "/api/respond?mode=practice", audio: true },
    { method: "POST", path: "/api/respond?mode=practice&session=bad&task=bad&source=bad&threshold=2", audio: true },
    { method: "POST", path: `/api/respond?mode=practice&session=${id}&seconds=30&temperature=0&difficulty=9&surprise=2&stage=bad`, audio: true },
  ];
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient
import piano_duet.server as server
class Engine:
    def __init__(self): self.generator = SimpleNamespace(phrase=None)
cases = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=Engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        result = []
        for case in cases:
            options = {'headers':{'X-Duet-Client':'1'}}
            if case.get('audio'): options['content'] = bytes(6400)
            elif 'body' in case: options['json'] = case['body']
            response = client.request(case['method'], case['path'], **options)
            result.append({'status':response.status_code, 'locations':[item['loc'] for item in response.json()['detail']]})
print(json.dumps(result))
`], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected: { status: number; locations: (string | number)[][] }[] = JSON.parse(reference.stdout);
  const service = new LocalService({ async list() { return []; } });
  const locations = (rows: (string | number)[][]) => rows.map((row) => JSON.stringify(row)).sort();
  for (const [index, item] of cases.entries()) {
    const options: RequestInit = { method: item.method };
    if (item.audio) options.body = new Uint8Array(6400);
    else if (Object.hasOwn(item, "body")) options.body = JSON.stringify(item.body);
    const response = await service.fetch(item.path, options);
    const actual = await response.json();
    assert.equal(response.status, expected[index].status, `case ${index}: ${item.path}`);
    assert.ok(actual.detail.every((row: { loc: unknown; msg: unknown; type: unknown }) => Array.isArray(row.loc)
      && typeof row.msg === "string" && typeof row.type === "string"));
    assert.deepEqual(locations(actual.detail.map((row: { loc: (string | number)[] }) => row.loc)), locations(expected[index].locations), `case ${index}: ${item.path}`);
  }
});
