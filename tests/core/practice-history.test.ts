import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalEventStore, LocalJsonValue } from "../../src/core/local-service.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";

const attemptId = "a1a1a1a1-1111-4111-8111-111111111111";
const notes = [
  { pitch: 60, start: 1.5, duration: 0.5, velocity: 80 },
  { pitch: 64, start: 2.5, duration: 0.6, velocity: 90 },
  { pitch: 67, start: 3.5, duration: 0.7, velocity: 85 },
];
const payload = { mode: "practice", prompt: { family: "technique", title: "Scale", target: [] },
  context: { source: "microphone" }, notes, assessment: { evidence: [] } };

test("saved pieces, exclusion and history export match FastAPI and survive service reload", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient
import piano_duet.server as server
class Engine:
    def __init__(self):
        self.generator = SimpleNamespace(phrase=None)
case = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=Engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        inputs = {k: v for k, v in case['payload'].items() if k != 'assessment'}
        client.app.state.store.record(case['id'], inputs, case['payload']['assessment'])
        piece = client.post('/api/pieces', json={'attempt': case['id'], 'title': '  Study  '}, headers={'X-Duet-Client': '1'}).json()
        client.post('/api/attempts/' + case['id'] + '/exclude', json={'excluded': True}, headers={'X-Duet-Client': '1'})
        export = client.get('/api/profile/export')
        data = export.json()
        header = export.headers['content-disposition']
print(json.dumps({'piece': piece, 'export': data, 'header': header}))
`], { input: JSON.stringify({ id: attemptId, payload }), encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const events: ReadingLogEvent[] = [{ id: attemptId, deviceId: "device", clock: 1, createdAt: "2024-01-01T00:00:00.000Z", kind: "attempt", payload }];
  const store: LocalEventStore = {
    async list() { return [...events]; },
    async append(kind, data: LocalJsonValue, id = crypto.randomUUID()) {
      const event = { id, deviceId: "device", clock: events.length + 1, createdAt: "2024-01-01T00:00:00.000Z", kind, payload: data };
      events.push(event); return event;
    },
  };
  let service = new LocalService(store, undefined, () => 1704067200);
  const piece = await (await service.fetch("/api/pieces", { method: "POST", body: JSON.stringify({ attempt: attemptId, title: "  Study  " }) })).json();
  expected.piece.id = piece.id;
  assert.deepEqual(piece, expected.piece);
  await service.fetch(`/api/attempts/${attemptId}/exclude`, { method: "POST", body: JSON.stringify({ excluded: true }) });
  service = new LocalService(store, undefined, () => 1704067200);
  assert.deepEqual(await (await service.fetch("/api/pieces")).json(), [piece]);
  const response = await service.fetch("/api/profile/export");
  assert.equal(response.headers.get("content-disposition"), expected.header);
  const exported = await response.json();
  expected.export.attempts[0].created_at = 1704067200;
  expected.export.pieces[0].id = piece.id;
  assert.deepEqual(exported, expected.export);
  await service.fetch(`/api/attempts/${attemptId}/exclude`, { method: "POST", body: JSON.stringify({ excluded: false }) });
  assert.equal((await (await service.fetch("/api/profile")).json()).included_attempts, 1);
});
