import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer, enableAllModes } from "../web/server.mjs";
import { MODEL_CATALOG } from "../../site/app/src/model-catalog.ts";

const staticBase = `/@fs${resolve("src/piano_duet/static")}`;
const modelDirectory = process.env.PIANO_RECORDING_MODEL_DIR ?? ".cache/models/recording-transcription/onnx-fp32";
const files = [];
for (const [role, name, sha256, bytes] of [["features", "features.onnx", "8c9d550d34662cd89d9271711cf59e5cd53820861e1f706c1766df3eb7388757", 53313300],
  ["attributes", "attributes.onnx", "3c23a41616772ae9bc7a0b090558d09848d7e13f99607f5dc82629a5decfa29c", 3423800]]) {
  const path = `${modelDirectory}/${name}`;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal((await stat(path)).size, bytes);
  assert.equal(hash.digest("hex"), sha256);
  files.push({ model: "recording-transcription", role, name, revision: "local-fixture", sha256, bytes });
}
const sample = await readFile(".cache/browser-inference/C4.mp3");
const entry = { pitch: 60, file: "C4.mp3", sha256: "a265c8cfd4140cf27b55054b4953b6c691fce3523530ca8ae0faed5e4cd39063", bytes: 239164 };
assert.equal(sample.length, entry.bytes);
assert.equal(createHash("sha256").update(sample).digest("hex"), entry.sha256);
const channel = process.env.PIANO_BROWSER_CHANNEL ?? "chromium";
const models = await startServer();
let site, browser, context;
const errors = [];
try {
  site = await startTestServer();
  const base = `http://127.0.0.1:${models.address().port}`;
  const assets = files.map((file) => ({ ...file, url: `${base}/models/local-fixture/recording-${file.name}` }));
  browser = await chromium.launch({ channel, headless: true, args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  context = await browser.newContext({ permissions: ["microphone"] });
  await enableAllModes(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => process.stderr.write(`Page ${message.type()}: ${message.text()}\n`));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  await context.route("**/src/model-catalog.ts", (route) => route.fulfill({ contentType: "text/javascript",
    body: `export const MODEL_CATALOG = ${JSON.stringify({ ...MODEL_CATALOG, "recording-transcription": assets })};` }));
  await context.route("**/src/piano-samples.ts", (route) => route.fulfill({ contentType: "text/javascript",
    body: `export const SAMPLE_REVISION = "local-fixture"; export const PIANO_SAMPLES = ${JSON.stringify([entry])};` }));
  await context.route("https://raw.githubusercontent.com/**/local-fixture/samples/piano/C4.mp3", (route) => route.fulfill({ body: sample,
    headers: { "Content-Type": "audio/mpeg", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" } }));
  await page.addInitScript(() => {
    window.__drillTest = { task: null, audio: null, destination: null, workers: [] };
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.value?.recordingWorkers) window.__drillTest.workers.push(...data.value.recordingWorkers);
        });
      }
    };
    const json = Response.json.bind(Response);
    Response.json = (value, options) => {
      if (value?.drill?.config_key && Array.isArray(value.target)) window.__drillTest.task = value;
      return json(value, options);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 16000 });
      const destination = audio.createMediaStreamDestination();
      await audio.resume();
      if (audio.state !== "running") throw new Error(`Fake microphone audio context is ${audio.state}`);
      Object.assign(window.__drillTest, { audio, destination });
      return destination.stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => [];
  });
  await page.goto(`http://127.0.0.1:${site.port}/`);
  const gpu = await page.evaluate(() => new Promise((resolve, reject) => {
    const source = `self.onmessage = async () => { const gpu = navigator.gpu; const adapter = gpu && await gpu.requestAdapter();
      self.postMessage({ available: Boolean(gpu), adapter: adapter ? { vendor: adapter.info?.vendor ?? null,
        architecture: adapter.info?.architecture ?? null, device: adapter.info?.device ?? null, description: adapter.info?.description ?? null } : null }); };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = ({ data }) => { worker.terminate(); URL.revokeObjectURL(url); resolve(data); };
    worker.onerror = (event) => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error(event.message)); };
    worker.postMessage(null);
  }));
  process.stderr.write(`Worker WebGPU: ${JSON.stringify(gpu)}\n`);
  await page.waitForFunction(() => document.querySelector("#practiceTitle")?.textContent === "C major scale", null, { timeout: 30000 })
    .catch(async (error) => {
      const state = await page.evaluate(() => ({ title: document.querySelector("#practiceTitle")?.textContent,
        status: document.querySelector("#status")?.textContent, error: document.querySelector("#error")?.textContent,
        errorHidden: document.querySelector("#error")?.hidden, download: document.querySelector(".asset-download")?.textContent,
        location: location.href, ready: document.readyState, isolated: crossOriginIsolated }));
      throw new Error(`${error}: ${JSON.stringify({ state, errors })}`);
    });
  await page.locator("#modeMenuButton").click();
    await page.locator("#drillsMode").click();
  await page.waitForFunction(() => window.__drillTest.task?.drill?.drill === "five_finger" && !document.querySelector("#start").disabled);
  await page.locator("#start").click();
  await page.waitForFunction(() => window.__drillTest.audio && window.__drillTest.destination);
  await page.evaluate(async (path) => {
    const { PianoSound } = await import(`${path}/audio.mjs`);
    const { audio, destination, task } = window.__drillTest;
    const piano = new PianoSound(audio);
    await piano.load();
    const start = audio.currentTime + 2;
    for (const note of task.target) piano.play(note, start + note.start, audio, destination);
  }, staticBase);
  await page.waitForFunction(() => !document.querySelector("#drillLast").hidden || !document.querySelector("#error").hidden,
    null, { timeout: 60000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({ status: document.querySelector("#status")?.textContent,
      message: document.querySelector("#message")?.textContent, error: document.querySelector("#error")?.textContent,
      context: window.__drillTest.audio?.state, time: window.__drillTest.audio?.currentTime,
      download: document.querySelector(".asset-download")?.textContent, task: window.__drillTest.task?.title }));
    throw new Error(`${error}: ${JSON.stringify({ state, errors })}`);
  });
  const result = await page.evaluate(async (path) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    const profile = await localRequest("/api/profile");
    const last = profile.recent[0];
    const attempt = last && await localRequest(`/api/attempts/${last.id}`);
    return { attempt, workers: window.__drillTest.workers, results: document.querySelector("#drillResults").textContent,
      error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent };
  }, staticBase);
  if (result.error) throw new Error(result.error);
  assert.deepEqual(errors, []);
  assert.ok(result.workers.length > 0 && result.workers.every((worker) => worker.provider === "wasm" && worker.threads > 0), "Recording workers did not initialize on WASM");
  assert.ok(result.attempt?.notes.length >= 5, "The drill take did not recognize enough notes");
  assert.ok(["attacks", "quiet", "limit"].includes(result.attempt.context.audio.listening.ended), "The take did not end automatically");
  assert.ok(result.results.length > 0, "The results panel is empty");
  console.log(JSON.stringify({ workers: result.workers, notes: result.attempt.notes.length, ended: result.attempt.context.audio.listening.ended,
    heardAttacks: result.attempt.context.audio.listening.attacks.length, score: result.attempt.assessment.score,
    result: result.attempt.assessment.drill }, null, 2));
} finally {
  await context?.close();
  await browser?.close();
  site?.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
