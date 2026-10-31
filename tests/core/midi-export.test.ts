import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import { parseMidi } from "../../src/core/score-midi.ts";

test("MIDI export reproduces Python's performance notes and response headers", async () => {
  const cases = [
    [{ pitch: 60, start: 1, duration: 0.5, velocity: 80 }, { pitch: 64, start: 1.5, duration: 1, velocity: 90 }],
    [{ pitch: 67, start: 0, duration: 1, velocity: 95 }, { pitch: 60, start: 0, duration: 0.5, velocity: 75 },
      { pitch: 64, start: 0.5, duration: 0.999, velocity: 85 }],
    [{ pitch: 60, start: 0, duration: 2, velocity: 75 }, { pitch: 60, start: 1, duration: 1, velocity: 85 },
      { pitch: 60, start: 1, duration: 2, velocity: 90 }, { pitch: 60, start: 1, duration: 2, velocity: 100 }],
  ];
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import contextlib, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient
import piano_duet.server as server
cases = json.load(sys.stdin)
class Engine:
    def __init__(self): self.generator = SimpleNamespace(phrase=None)
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=Engine, profile_path=Path(directory) / 'learner.sqlite3')) as client:
        responses = [client.post('/api/export', json={'notes':notes}, headers={'X-Duet-Client':'1'}) for notes in cases]
        result = [{'bytes':list(r.content),'type':r.headers['content-type'],'disposition':r.headers['content-disposition']} for r in responses]
print(json.dumps(result))
`], { input: JSON.stringify(cases), encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  const service = new LocalService({ async list() { return []; } });
  for (const [index, notes] of cases.entries()) {
    const response = await service.fetch("/api/export", { method: "POST", body: JSON.stringify({ notes }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), expected[index].type);
    assert.equal(response.headers.get("content-disposition"), expected[index].disposition);
    assert.deepEqual(parseMidi(new Uint8Array(await response.arrayBuffer())), parseMidi(new Uint8Array(expected[index].bytes)));
  }
  assert.equal((await service.fetch("/api/export", { method: "POST", body: JSON.stringify({ notes: [] }) })).status, 422);
});
