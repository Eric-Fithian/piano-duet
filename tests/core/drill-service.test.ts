import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalEventStore, LocalJsonValue, LocalRecordingTranscriber } from "../../src/core/local-service.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";

test("three locally transcribed drill takes match the Python flow and advance progress", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, tempfile
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from fastapi.testclient import TestClient
import piano_duet.server as server
from piano_duet.notes import Note
engine = SimpleNamespace(transcriber=SimpleNamespace(), generator=SimpleNamespace(phrase=None), notes=[])
server.RecordingTranscriber = lambda: SimpleNamespace(transcribe=lambda audio, cancel, progress: engine.notes)
session = '9cfb60dc-a9f7-4e10-9b04-033934f96d9b'
request = {'drill': 'scale', 'variant': 'major', 'tonic': 0, 'hands': 'right', 'octaves': 1, 'practice': 'even'}
listening = {'ended': 'attacks', 'floor': 0.0091, 'noise': 0.003, 'attacks': [0.22, 0.6], 'strengths': [0.03, 0.02], 'seconds': 1.2}
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=lambda: engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        outcomes = []
        for index in range(3):
            task = client.post('/api/drills/next', json=request, headers={'X-Duet-Client': '1'}).json()
            engine.notes = [Note.model_validate(note) for note in task['target']]
            attempt = f'5cfb60dc-a9f7-4e10-9b04-033934f96d9{index}'
            response = client.post('/api/respond', params={'mode':'drills','session':session,'task':task['id'],'attempt':attempt,
                                   'listening':json.dumps(listening)}, content=np.zeros(3200,dtype='<f4').tobytes(), headers={'X-Duet-Client':'1'})
            assert response.status_code == 200, response.text
            events = [json.loads(line) for line in response.text.splitlines()]
            outcomes.append({'task': task, 'events': events, 'saved': client.get(f'/api/attempts/{attempt}').json()})
        summary = client.get('/api/drills').json()
print(json.dumps({'outcomes': outcomes, 'summary': summary}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload: LocalJsonValue, id) {
    if (!id) throw new Error("Expected an explicit attempt ID");
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
    events.push(event); return event;
  } };
  let notes: { pitch: number; start: number; duration: number; velocity: number }[] = [];
  const recorder: LocalRecordingTranscriber = { async run(input) {
    assert.equal(input.sampleRate, 16000);
    assert.equal(input.audio.length, 3200);
    return { notes };
  } };
  const service = new LocalService(store, undefined, undefined, undefined, undefined, undefined, recorder);
  const session = "9cfb60dc-a9f7-4e10-9b04-033934f96d9b";
  const request = { drill: "scale", variant: "major", tonic: 0, hands: "right", octaves: 1, practice: "even" };
  const listening = { ended: "attacks", floor: 0.0091, noise: 0.003, attacks: [0.22, 0.6], strengths: [0.03, 0.02], seconds: 1.2 };
  for (let index = 0; index < 3; index++) {
    const task = await (await service.fetch("/api/drills/next", { method: "POST", body: JSON.stringify(request) })).json();
    expected.outcomes[index].task.id = task.id;
    assert.deepEqual(task, expected.outcomes[index].task);
    notes = task.target.map(({ pitch, start, duration, velocity }: typeof notes[number]) => ({ pitch, start, duration, velocity }));
    const attempt = `5cfb60dc-a9f7-4e10-9b04-033934f96d9${index}`;
    const params = new URLSearchParams({ mode: "drills", session, task: task.id, attempt, listening: JSON.stringify(listening) });
    const response = await service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer });
    assert.equal(response.status, 200);
    const actualEvents = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type !== "transcribing");
    const referenceEvents = expected.outcomes[index].events.filter((event: { type: string }) => event.type !== "transcribing");
    for (const event of [...actualEvents, ...referenceEvents]) if (event.type === "heard") delete event.transcription_ms;
    assert.deepEqual(actualEvents, referenceEvents);
    const saved = await (await service.fetch(`/api/attempts/${attempt}`)).json();
    const referenceSaved = expected.outcomes[index].saved;
    referenceSaved.created_at = saved.created_at;
    referenceSaved.prompt.id = saved.prompt.id;
    assert.deepEqual(saved, referenceSaved);
    assert.equal((await service.fetch(`/api/respond?${params}`, { method: "POST", body: new Float32Array(3200).buffer })).status, 409);
  }
  const summary = await (await service.fetch("/api/drills")).json();
  const referenceSummary = expected.summary;
  for (const key of Object.keys(summary.progress)) referenceSummary.progress[key].last = summary.progress[key].last;
  for (const key of Object.keys(summary.levels)) referenceSummary.levels[key].last = summary.levels[key].last;
  assert.deepEqual(summary, referenceSummary);
});

test("cancelled or invalid drill takes do not save events and release the recording slot", async () => {
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload, id) {
    if (!id) throw new Error("Expected an attempt ID");
    const event = { id, kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
    events.push(event); return event;
  } };
  const recorder: LocalRecordingTranscriber = { run(_input, signal) {
    return new Promise((_resolve, reject) => {
      if (!signal) throw new Error("The transcriber needs cancellation");
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  } };
  const service = new LocalService(store, undefined, undefined, undefined, undefined, undefined, recorder);
  const task = await (await service.fetch("/api/drills/next", { method: "POST", body: "{}" })).json();
  const params = new URLSearchParams({ mode: "drills", session: "9cfb60dc-a9f7-4e10-9b04-033934f96d9b", task: task.id,
    attempt: "5cfb60dc-a9f7-4e10-9b04-033934f96d90" });
  const audio = new Float32Array(3200);
  audio[0] = NaN;
  assert.equal((await service.fetch(`/api/respond?${params}`, { method: "POST", body: audio.buffer })).status, 400);
  audio[0] = 0;
  const abort = new AbortController();
  const response = await service.fetch(`/api/respond?${params}`, { method: "POST", body: audio.buffer, signal: abort.signal });
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal((await service.fetch(`/api/respond?${params}`, { method: "POST", body: audio.buffer })).status, 409);
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(events.length, 0);
  assert.equal((await (await service.fetch("/api/status")).json()).busy, false);
});
