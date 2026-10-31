import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LocalService } from "../../src/core/local-service.ts";
import type { LocalEventStore, LocalJsonValue } from "../../src/core/local-service.ts";
import { libraryFromEvents } from "../../src/core/library-events.ts";
import type { ReadingLogEvent } from "../../src/core/reading-events.ts";

test("library import, play, edit, revert and deletion match Python through event replay", async () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import base64, contextlib, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient
import piano_duet.server as server
sys.path.insert(0, 'tests')
from test_library import MUSICXML
headers = {'X-Duet-Client':'1'}
engine = SimpleNamespace(transcriber=SimpleNamespace(), generator=SimpleNamespace(phrase=None))
with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
    server.SAMPLES = server.NOTATION = Path(directory)
    with TestClient(server.create_app(engine_factory=lambda:engine, profile_path=Path(directory)/'learner.sqlite3')) as client:
        imported = client.post('/api/library/import?filename=idea.musicxml&artist=Gibran%20Alcocer', content=MUSICXML.encode(), headers=headers).json()
        song_id = imported['id']
        listing = client.get('/api/library').json()
        full = client.get(f'/api/library/{song_id}').json()
        play = {'id':'5cfb60dc-a9f7-4e10-9b04-033934f96d90','attacks':[[0,True],[1,False]]}
        stats = client.post(f'/api/library/{song_id}/plays', json=play, headers=headers).json()
        slower = [{**note, 'start':note['start']*2, 'duration':note['duration']*2} for note in full['notes']]
        edit = {'bpm':full['bpm']//2, 'meter':'3/4', 'tonic':9, 'mode':'minor', 'notes':slower}
        edited = client.put(f'/api/library/{song_id}', json=edit, headers=headers).json()
        fewer = client.put(f'/api/library/{song_id}', json={**edit,'notes':slower[1:]}, headers=headers).json()
        reverted = client.post(f'/api/library/{song_id}/revert', json={}, headers=headers).json()
        deleted = client.delete(f'/api/library/{song_id}', headers=headers).json()
        final = client.get('/api/library').json()
print(json.dumps({'xml':base64.b64encode(MUSICXML.encode()).decode(), 'imported':imported, 'listing':listing,
                  'full':full, 'play':play, 'stats':stats, 'edit':edit, 'edited':edited, 'fewer':fewer,
                  'reverted':reverted, 'deleted':deleted, 'final':final}))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout), events: ReadingLogEvent[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload: LocalJsonValue, id) {
    const event = { id: id ?? crypto.randomUUID(), kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
    events.push(event); return event;
  } };
  let service = new LocalService(store);
  const xml = Uint8Array.from(Buffer.from(expected.xml, "base64"));
  const importResponse = await service.fetch("/api/library/import?filename=idea.musicxml&artist=Gibran%20Alcocer", { method: "POST", body: xml });
  assert.equal(importResponse.status, 200);
  const imported = await importResponse.json(), id = imported.id;
  assert.deepEqual(scrub(imported), scrub(expected.imported));
  assert.deepEqual(scrub(await (await service.fetch("/api/library")).json()), scrub(expected.listing));
  assert.deepEqual(scrub(await (await service.fetch(`/api/library/${id}`)).json()), scrub(expected.full));
  const play = await service.fetch(`/api/library/${id}/plays`, { method: "POST", body: JSON.stringify(expected.play) });
  assert.equal(play.status, 200);
  assert.deepEqual(scrub(await play.json()), scrub(expected.stats));
  service = new LocalService(store);
  const edit = await service.fetch(`/api/library/${id}`, { method: "PUT", body: JSON.stringify(expected.edit) });
  assert.equal(edit.status, 200);
  assert.deepEqual(scrub(await edit.json()), scrub(expected.edited));
  const fewer = await service.fetch(`/api/library/${id}`, { method: "PUT", body: JSON.stringify({ ...expected.edit, notes: expected.edit.notes.slice(1) }) });
  assert.deepEqual(scrub(await fewer.json()), scrub(expected.fewer));
  const revert = await service.fetch(`/api/library/${id}/revert`, { method: "POST", body: "{}" });
  assert.deepEqual(scrub(await revert.json()), scrub(expected.reverted));
  const state = libraryFromEvents(events), reversed = libraryFromEvents([...events].reverse());
  assert.deepEqual([...state.songs], [...reversed.songs]);
  assert.deepEqual([...state.plays], [...reversed.plays]);
  const deleted = await service.fetch(`/api/library/${id}`, { method: "DELETE" });
  assert.deepEqual(scrub(await deleted.json()), scrub(expected.deleted));
  assert.deepEqual(await (await service.fetch("/api/library")).json(), expected.final);
  assert.equal((await service.fetch(`/api/library/${id}`)).status, 404);
  const bomb = new TextEncoder().encode('<!DOCTYPE score-partwise [<!ENTITY x "boom">]><score-partwise>&x;</score-partwise>');
  const rejected = await service.fetch("/api/library/import?filename=bomb.musicxml", { method: "POST", body: bomb });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).detail, "Could not import bomb.musicxml: MusicXML entity declarations are not supported");
  const malformed = await service.fetch("/api/library/import?filename=broken.musicxml", { method: "POST", body: new TextEncoder().encode('<score-partwise><part>') });
  assert.equal(malformed.status, 400);
  assert.ok((await malformed.json()).detail.startsWith("Could not import broken.musicxml: Invalid MusicXML:"));
  assert.equal((await service.fetch("/api/library/import?filename=empty.mid", { method: "POST", body: new Uint8Array() })).status, 400);
});

test("recording import requires rights and stores only the generated song", async () => {
  const events: ReadingLogEvent[] = [], calls: ArrayBuffer[] = [];
  const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload: LocalJsonValue, id) {
    const event = { id: id ?? crypto.randomUUID(), kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
    events.push(event); return event;
  } };
  const musicXml = readFileSync("tests/fixtures/score-writing/reference.musicxml", "utf8");
  const importer = { async run(data: ArrayBuffer) { calls.push(data); return { musicXml,
    notes: Array.from({ length: 13 }, (_, index) => ({ start: index * 0.5 })) }; } };
  const service = new LocalService(store, undefined, undefined, undefined, undefined, undefined, undefined, importer);
  const body = Uint8Array.of(1, 2, 3).buffer;
  assert.equal((await service.fetch("/api/library/import-audio?filename=piece.wav", { method: "POST", body })).status, 400);
  assert.equal(calls.length, 0);
  const response = await service.fetch("/api/library/import-audio?filename=piece.wav&rights=1", { method: "POST", body });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "song");
  assert.equal(JSON.stringify(events).includes("1,2,3"), false);
  assert.equal((await (await service.fetch("/api/library")).json()).songs.length, 1);
});

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "id" || key === "deleted" ? "id"
    : key === "created_at" || key === "last_played" && item !== null ? 0 : scrub(item)]));
}
