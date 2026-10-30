import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalTranscriber } from "../../src/core/local-service.ts";

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
        task = client.post("/api/practice/next", json={"focus": "guided"}, headers={"X-Duet-Client": "1"}).json()
        aided = client.post(f"/api/practice/{task['id']}/aid", json={"kind": "hearings"}, headers={"X-Duet-Client": "1"}).json()
        audio = np.zeros(32000, dtype="<f4")
        audio[0], audio[1] = 1, 2
        heard = client.post("/api/reading/listen?threshold=0.8", content=audio.tobytes(), headers={"X-Duet-Client": "1"}).json()
        invalid = client.post("/api/reading/listen", content=b"x", headers={"X-Duet-Client": "1"})
profile["generated_at"] = 1700000000
print(json.dumps({"status": status, "profile": profile, "pieces": pieces, "task": task, "aided": aided, "heard": heard["notes"], "invalid": {"status": invalid.status_code, "body": invalid.json()}}))
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
