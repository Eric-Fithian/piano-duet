import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalTranscriber } from "../../src/core/local-service.ts";
import type { LocalEventStore } from "../../src/core/local-service.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";
import { ReadingReplay } from "./reading-replay.ts";

test("local status, profile and live transcription match FastAPI response shapes", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, tempfile
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from fastapi.testclient import TestClient
import piano_duet.server as server
class Engine:
    def __init__(self):
        self.transcriber = SimpleNamespace(listen=lambda audio, threshold: [{"pitch": 60, "start": 0.5, "velocity": 80, "confidence": float(audio[0])}])
        self.generator = SimpleNamespace(phrase=None)
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=Engine, profile_path=Path(directory) / "learner.sqlite3")) as client:
        status = client.get("/api/status").json()
        profile = client.get("/api/profile").json()
        pieces = client.get("/api/pieces").json()
        library = client.get("/api/library").json()
        drills = client.get("/api/drills").json()
        drill_coach = client.post("/api/drills/next", json={}, headers={"X-Duet-Client": "1"}).json()
        drill_choice = client.post("/api/drills/next", json={"drill": "scale", "variant": "major", "tonic": 0, "hands": "right", "octaves": 1, "practice": "even"}, headers={"X-Duet-Client": "1"}).json()
        invalid_drills = [{"drill": "scale"}, {"practice": "bad"}, {"tonic": 12}, {"drill": "scale", "variant": "melodic minor", "tonic": 0, "hands": "contrary", "octaves": 1}]
        invalid_drill_responses = [client.post("/api/drills/next", json=body, headers={"X-Duet-Client": "1"}) for body in invalid_drills]
        task = client.post("/api/practice/next", json={"focus": "guided"}, headers={"X-Duet-Client": "1"}).json()
        aided = client.post(f"/api/practice/{task['id']}/aid", json={"kind": "hearings"}, headers={"X-Duet-Client": "1"}).json()
        audio = np.zeros(32000, dtype="<f4")
        audio[0], audio[1] = 1, 2
        heard = client.post("/api/reading/listen?threshold=0.8", content=audio.tobytes(), headers={"X-Duet-Client": "1"}).json()
        invalid = client.post("/api/reading/listen", content=b"x", headers={"X-Duet-Client": "1"})
profile["generated_at"] = 1700000000
print(json.dumps({"status": status, "profile": profile, "pieces": pieces, "library": library, "drills": drills, "drill_coach": drill_coach, "drill_choice": drill_choice, "invalid_drills": invalid_drills, "invalid_drill_statuses": [r.status_code for r in invalid_drill_responses], "task": task, "aided": aided, "heard": heard["notes"], "invalid": {"status": invalid.status_code, "body": invalid.json()}}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const transcriber: LocalTranscriber = { async run(input) {
    assert.equal(input.sampleRate, 16000);
    assert.equal(input.threshold, 0.8);
    assert.equal(input.audio[1], 1);
    return { notes: [{ pitch: 60, start: 0.5, velocity: 80, confidence: input.audio[0] }] };
  } };
  const service = new LocalService({ async list() { return []; } }, transcriber, () => 1700000000);
  const status = await (await service.fetch("/api/status")).json();
  assert.deepEqual({ ...status, model: expected.status.model }, expected.status);
  assert.deepEqual(await (await service.fetch("/api/profile")).json(), expected.profile);
  assert.deepEqual(await (await service.fetch("/api/pieces")).json(), expected.pieces);
  assert.deepEqual(await (await service.fetch("/api/library")).json(), expected.library);
  assert.deepEqual(await (await service.fetch("/api/drills")).json(), expected.drills);
  for (const [body, reference] of [[{}, expected.drill_coach], [{ drill: "scale", variant: "major", tonic: 0, hands: "right", octaves: 1, practice: "even" }, expected.drill_choice]] as const) {
    const drill = await (await service.fetch("/api/drills/next", { method: "POST", body: JSON.stringify(body) })).json();
    reference.id = drill.id;
    assert.deepEqual(drill, reference);
  }
  for (const [index, body] of expected.invalid_drills.entries()) {
    const response = await service.fetch("/api/drills/next", { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, expected.invalid_drill_statuses[index]);
  }
  const task = await (await service.fetch("/api/practice/next", { method: "POST", body: JSON.stringify({ focus: "guided" }) })).json();
  expected.task.id = task.id;
  assert.deepEqual(task, expected.task);
  const aided = await (await service.fetch(`/api/practice/${task.id}/aid`, { method: "POST", body: JSON.stringify({ kind: "hearings" }) })).json();
  expected.aided.id = task.id;
  assert.deepEqual(aided, expected.aided);
  const audio = new Float32Array(32000); audio[0] = 1; audio[1] = 2;
  const heard = await (await service.fetch("/api/reading/listen?threshold=0.8", { method: "POST", body: audio.buffer })).json();
  assert.deepEqual(heard.notes, expected.heard);
  assert.equal(typeof heard.inference_ms, "number");
  const invalid = await service.fetch("/api/reading/listen", { method: "POST", body: new Uint8Array(1) });
  assert.equal(invalid.status, expected.invalid.status);
  assert.deepEqual(await invalid.json(), expected.invalid.body);
});

test("live recognition prevents concurrent windows and rejects non-finite audio", async () => {
  let finish: ((value: { notes: unknown[] }) => void) | undefined;
  const service = new LocalService({ async list() { return []; } }, { run() { return new Promise((resolve) => { finish = resolve; }); } });
  const audio = new Float32Array(32000);
  const first = service.fetch("/api/reading/listen", { method: "POST", body: audio.buffer });
  const second = await service.fetch("/api/reading/listen", { method: "POST", body: audio.buffer });
  assert.equal(second.status, 409);
  assert.ok(finish);
  finish({ notes: [] });
  assert.equal((await first).status, 200);
  audio[4] = NaN;
  assert.equal((await service.fetch("/api/reading/listen", { method: "POST", body: audio.buffer })).status, 400);
  assert.equal((await service.fetch("/api/not-ready")).status, 501);
});

test("Reading introduction and completion match the Python endpoints", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient
sys.path.insert(0, "tests")
from reading_recording import RecordingPhrase, RecordingRandom
import piano_duet.server as server
events = []
original = server.next_task
def recorded(*args):
    args = list(args)
    args[2] = RecordingRandom(0, events)
    return original(*args)
server.next_task = recorded
class Engine:
    def __init__(self):
        self.transcriber = SimpleNamespace()
        self.generator = SimpleNamespace(phrase=RecordingPhrase)
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=Engine, profile_path=Path(directory) / "learner.sqlite3")) as client:
        headers = {"X-Duet-Client": "1"}
        response = client.post("/api/practice/next", json={"focus": "reading", "step_by_step": True}, headers=headers)
        assert response.status_code == 200, response.text
        task = response.json()
        preview = client.post("/api/practice/next", json={"focus": "reading", "step_by_step": True, "after": task["id"]}, headers=headers)
        assert preview.status_code == 200, preview.text
        attempt = "5cfb60dc-a9f7-4e10-9b04-033934f96d9b"
        groups = [[{"pitch": note["pitch"], "start": 1.0 + index, "velocity": 80, "confidence": 0.95}] for index, note in enumerate(task["target"])]
        result = client.post("/api/reading/complete", json={"task": task["id"], "attempt": attempt, "groups": groups, "interruptions": [], "threshold": 0.8}, headers=headers)
        assert result.status_code == 200, result.text
        profile = client.get("/api/profile").json()
        detail = client.get(f"/api/attempts/{attempt}").json()
        excluded = client.post(f"/api/attempts/{attempt}/exclude", json={"excluded": True}, headers=headers).json()
        excluded_detail = client.get(f"/api/attempts/{attempt}").json()
        restored = client.post(f"/api/attempts/{attempt}/exclude", json={"excluded": False}, headers=headers).json()
        repeat = client.post("/api/reading/complete", json={"task": task["id"], "attempt": attempt, "groups": groups, "interruptions": [], "threshold": 0.8}, headers=headers)
print(json.dumps({"task": task, "preview": preview.json(), "events": events, "groups": groups, "result": result.json(), "detail": detail, "excluded": excluded, "excluded_detail": excluded_detail, "restored": restored, "repeat": repeat.status_code, "introductions": profile["reading"]["introductions"]}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return events; }, async append(kind, payload, eventId) {
    const event = { id: eventId ?? crypto.randomUUID(), deviceId: "test", clock: events.length + 1, createdAt: "2024-01-01T00:00:00Z", kind, payload };
    events.push(event);
    return event;
  } };
  const replay = new ReadingReplay(expected.events);
  const service = new LocalService(store, undefined, () => 1700000000, undefined, replay);
  const request = (path: string, body: unknown) => service.fetch(path, { method: "POST", body: JSON.stringify(body) });
  const response = await request("/api/practice/next", { focus: "reading", step_by_step: true });
  assert.equal(response.status, 200);
  const task = await response.json();
  expected.task.id = task.id;
  assert.deepEqual(task, expected.task);
  const preview = await (await request("/api/practice/next", { focus: "reading", step_by_step: true, after: task.id })).json();
  expected.preview.id = preview.id;
  assert.deepEqual(preview, expected.preview);
  replay.finish();
  const body = { task: task.id, attempt: expected.result.id, groups: expected.groups, interruptions: [], threshold: 0.8 };
  const incomplete = await request("/api/reading/complete", { ...body, groups: [[{ ...body.groups[0][0], pitch: 70 }]] });
  assert.equal(incomplete.status, 400);
  const saved = await request("/api/reading/complete", body);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), expected.result);
  assert.equal((await request("/api/reading/complete", body)).status, expected.repeat);
  const profile = await (await service.fetch("/api/profile")).json();
  assert.equal(profile.reading.introductions, expected.introductions);
  const detail = await (await service.fetch(`/api/attempts/${body.attempt}`)).json();
  expected.detail.created_at = detail.created_at;
  expected.detail.prompt.id = task.id;
  assert.deepEqual(detail, expected.detail);
  const excluded = await (await request(`/api/attempts/${body.attempt}/exclude`, { excluded: true })).json();
  assert.equal(excluded.included_attempts, expected.excluded.included_attempts);
  assert.equal(excluded.reading.introductions, expected.excluded.reading.introductions);
  const excludedDetail = await (await service.fetch(`/api/attempts/${body.attempt}`)).json();
  expected.excluded_detail.created_at = excludedDetail.created_at;
  expected.excluded_detail.prompt.id = task.id;
  assert.deepEqual(excludedDetail, expected.excluded_detail);
  const restored = await (await request(`/api/attempts/${body.attempt}/exclude`, { excluded: false })).json();
  assert.equal(restored.included_attempts, expected.restored.included_attempts);
  assert.equal(restored.reading.introductions, expected.restored.reading.introductions);
  assert.equal((await service.fetch("/api/attempts/unknown")).status, 404);
});
