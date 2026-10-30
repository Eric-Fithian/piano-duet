import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";

const source = process.argv[2] ?? ".cache/amt-bench/audio-real/commons_chopin_nocturne_op9_2.real.wav";
const seconds = Number(process.argv[3] ?? "16");
const pool = process.argv[4] === "pool";
const workers = pool ? Number(process.argv[5] ?? "3") : 1;
const threads = pool ? Number(process.argv[6] ?? "4") : 12;
const score = process.argv.includes("--score");
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("A positive recording length is required");
const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys, time
from threading import Event
import numpy as np
import soundfile as sf
from piano_duet.recording_transcription import RecordingTranscriber
samples, rate = sf.read(sys.argv[1], frames=int(float(sys.argv[2]) * 44100), dtype="float32")
assert rate == 44100 and samples.ndim == 1 and len(samples) > 0
samples.astype("<f4").tofile(".cache/browser-inference/recording.pcm")
model = RecordingTranscriber()
start = time.perf_counter()
notes = model.transcribe(samples, Event(), lambda progress: None)
elapsed = 1000*(time.perf_counter()-start)
score_result = None
if sys.argv[3] == "score":
    from piano_duet.score_model import checkpoint, performance_to_score
    start = time.perf_counter()
    result = performance_to_score(notes)
    score_result = {"checkpoint": checkpoint().name, "notes": len(result["notes"]), "elapsedMs": 1000*(time.perf_counter()-start)}
print(json.dumps({"notes": [note.model_dump() for note in notes], "seconds": len(samples)/rate, "elapsedMs": elapsed, "score": score_result}))
`, source, String(seconds), score ? "score" : "none"], { encoding: "utf8", maxBuffer: 8_000_000 });
assert.equal(reference.status, 0, reference.stderr);
const expected = JSON.parse(reference.stdout);
const assets = [];
const modelServer = await startServer();
const modelPort = modelServer.address().port;
for (const [role, name] of [["features", "features.onnx"], ["attributes", "attributes.onnx"]]) {
  const path = `.cache/models/recording-transcription/onnx-fp32/${name}`;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assets.push({ model: "recording-transcription", role, name, revision: "local-fixture",
    url: `http://127.0.0.1:${modelPort}/models/local-fixture/recording-${name}`,
    sha256: hash.digest("hex"), bytes: (await stat(path)).size });
}
const site = await startTestServer();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("pageerror", (error) => process.stderr.write(`${error}\n`));
await page.goto(`http://127.0.0.1:${site.port}/test/${pool ? "recording-pool" : "inference"}.html`);
await page.waitForFunction((pool) => pool ? typeof window.inspectRecordingPool === "function" : typeof window.createBrowserInference === "function", pool);
const result = pool ? await page.evaluate(({ base, workers, threads }) => window.inspectRecordingPool(base, workers, threads),
  { base: `http://127.0.0.1:${modelPort}`, workers, threads })
  : await page.evaluate(async ({ assets, modelPort }) => {
  const audio = new Float32Array(await (await fetch(`http://127.0.0.1:${modelPort}/fixtures/recording.pcm`)).arrayBuffer());
  const backend = window.createBrowserInference({ "recording-transcription": assets });
  const session = await backend.createSession("recording-transcription", () => {});
  const start = performance.now();
  const transcription = await session.run({ audio, sampleRate: 44100 });
  const elapsedMs = performance.now() - start;
  const provider = session.provider;
  await session.close();
  return { ...transcription, elapsedMs, provider };
  }, { assets, modelPort });
assert.equal(result.provider, "wasm");
const remaining = new Set(expected.notes.map((_, index) => index));
const matched = [];
for (const actual of result.notes) {
  let best = null, difference = Infinity;
  for (const index of remaining) {
    const target = expected.notes[index];
    const delta = Math.abs(target.start - actual.start);
    if (target.pitch === actual.pitch && delta < 0.03 && delta < difference) { best = index; difference = delta; }
  }
  if (best !== null) { matched.push([actual, expected.notes[best]]); remaining.delete(best); }
}
const precision = matched.length / result.notes.length, recall = matched.length / expected.notes.length;
console.log(JSON.stringify({ source, seconds: expected.seconds, provider: result.provider, workers: pool ? workers : "automatic",
  threadsPerWorker: pool ? threads : "automatic", referenceMs: expected.elapsedMs,
  browserMs: result.elapsedMs, referenceNotes: expected.notes.length, browserNotes: result.notes.length,
  matched: matched.length, precision, recall, maxOnsetDifference: Math.max(...matched.map(([a, b]) => Math.abs(a.start - b.start))),
  maxDurationDifference: Math.max(...matched.map(([a, b]) => Math.abs(a.duration - b.duration))),
  maxVelocityDifference: Math.max(...matched.map(([a, b]) => Math.abs(a.velocity - b.velocity))), referenceScore: expected.score }, null, 2));
await browser.close();
site.server.kill("SIGTERM");
await new Promise((resolve) => modelServer.close(resolve));
assert.ok(precision >= 0.98 && recall >= 0.98, "Recording onset parity fell below 98% precision or recall");
