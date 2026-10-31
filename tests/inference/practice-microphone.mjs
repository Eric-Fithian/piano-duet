import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { MODEL_CATALOG } from "../../site/app/src/model-catalog.ts";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";
import { browserProfile } from "./browser-profile.mjs";

const engineName = process.argv[2];
if (!["chromium", "webkit"].includes(engineName)) throw new Error("Choose chromium or webkit");
const sample = await readFile(".cache/browser-inference/C4.mp3");
const entry = { pitch: 60, file: "C4.mp3", sha256: "a265c8cfd4140cf27b55054b4953b6c691fce3523530ca8ae0faed5e4cd39063", bytes: 239164 };
assert.equal(sample.length, entry.bytes);
assert.equal(createHash("sha256").update(sample).digest("hex"), entry.sha256);
const profile = await browserProfile();
const models = await startServer({ port: Number(process.env.PIANO_MODEL_PORT ?? 0) });
const site = await startTestServer(false, Number(process.env.PIANO_SITE_PORT ?? 0));
let browser;
try {
  const engine = engineName === "chromium" ? chromium : webkit;
  browser = await engine.launchPersistentContext(profile.path, { headless: true,
    ...(engineName === "chromium" ? { channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] } : {}) });
  const base = `http://127.0.0.1:${models.address().port}`;
  const assets = MODEL_CATALOG["phrase-transcription"].map((asset) => ({ ...asset, revision: "local-fixture", url: `${base}/models/local-fixture/${asset.name}` }));
  await browser.route("**/src/model-catalog.ts", (route) => route.fulfill({ contentType: "text/javascript",
    body: `export const MODEL_CATALOG = ${JSON.stringify({ ...MODEL_CATALOG, "phrase-transcription": assets })};` }));
  await browser.route("**/src/piano-samples.ts", (route) => route.fulfill({ contentType: "text/javascript",
    body: `export const SAMPLE_REVISION = "local-fixture"; export const PIANO_SAMPLES = ${JSON.stringify([entry])};` }));
  await browser.route("https://raw.githubusercontent.com/**/local-fixture/samples/piano/C4.mp3", (route) => route.fulfill({ body: sample,
    headers: { "Content-Type": "audio/mpeg", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" } }));
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("practice-test-reload")) localStorage.setItem("piano-duet.mode", "practice");
    window.__practiceTest = { task: null, audio: null, destination: null };
    const json = Response.json.bind(Response);
    Response.json = (value, options) => {
      if (value?.family === "technique" && Array.isArray(value.target)) window.__practiceTest.task = value;
      return json(value, options);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 16000 }), destination = audio.createMediaStreamDestination();
      await audio.resume();
      if (audio.state !== "running") throw new Error("The fake microphone did not start");
      Object.assign(window.__practiceTest, { audio, destination });
      return destination.stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => [];
  });
  await page.goto(`http://127.0.0.1:${site.port}/`);
  await page.waitForFunction(() => window.__practiceTest.task && !document.querySelector("#start").disabled, null, { timeout: 30000 });
  await page.locator("#start").click();
  await page.waitForFunction(() => window.__practiceTest.audio && window.__practiceTest.destination);
  const staticBase = `/@fs${resolve("src/piano_duet/static")}`;
  await page.evaluate(async (path) => {
    const { PianoSound } = await import(`${path}/audio.mjs`);
    const { audio, destination, task } = window.__practiceTest;
    const piano = new PianoSound(audio);
    await piano.load();
    const start = audio.currentTime + 2;
    for (const [index, note] of task.target.slice(0, 4).entries()) piano.play({ ...note, duration: 0.35 }, start + index * 0.5, audio, destination);
  }, staticBase);
  await page.waitForTimeout(4500);
  if (await page.locator("#answer").isEnabled()) await page.locator("#answer").click();
  await page.waitForFunction(() => !document.querySelector("#practiceResult").hidden || !document.querySelector("#error").hidden,
    null, { timeout: 120000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({ status: document.querySelector("#status")?.textContent,
      message: document.querySelector("#message")?.textContent, error: document.querySelector("#error")?.textContent,
      download: document.querySelector(".asset-download")?.textContent, task: window.__practiceTest.task?.title }));
    throw new Error(`${error}: ${JSON.stringify({ state, errors })}`);
  });
  const result = await page.evaluate(async (path) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    const profile = await localRequest("/api/profile");
    return { last: profile.practice_recent[0], score: document.querySelector("#practiceScore").textContent,
      error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent };
  }, staticBase);
  if (result.error) throw new Error(result.error);
  assert.deepEqual(errors, []);
  assert.equal(result.last?.mode, "practice");
  assert.ok(result.last.note_count > 0 && result.last.assessment.score !== null);
  assert.ok(result.score.includes("/ 100"));
  await page.evaluate(() => { sessionStorage.setItem("practice-test-reload", "1"); localStorage.setItem("piano-duet.mode", "duet"); });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector("#start").disabled, null, { timeout: 30000 });
  const restored = await page.evaluate(async ({ path, id }) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    return localRequest(`/api/attempts/${id}`);
  }, { path: staticBase, id: result.last.id });
  assert.equal(restored.id, result.last.id);
  assert.equal(restored.notes.length, result.last.note_count);
  assert.deepEqual(restored.assessment, result.last.assessment);
  console.log(JSON.stringify({ engine: engineName, attempt: restored.id, notes: restored.notes.length, score: result.score }));
} finally {
  await browser?.close();
  await profile.cleanup();
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
