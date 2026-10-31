import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { MODEL_CATALOG } from "../../site/app/src/model-catalog.ts";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";
import { browserProfile } from "./browser-profile.mjs";

const sample = await readFile(".cache/browser-inference/C4.mp3");
const entry = { pitch: 60, file: "C4.mp3", sha256: "a265c8cfd4140cf27b55054b4953b6c691fce3523530ca8ae0faed5e4cd39063", bytes: 239164 };
assert.equal(sample.length, entry.bytes);
assert.equal(createHash("sha256").update(sample).digest("hex"), entry.sha256);
const profile = await browserProfile();
const models = await startServer({ port: Number(process.env.PIANO_MODEL_PORT ?? 0) });
const site = await startTestServer(false, Number(process.env.PIANO_SITE_PORT ?? 0));
let browser;
try {
  browser = await chromium.launchPersistentContext(profile.path, { channel: "chrome", headless: true, permissions: ["microphone"],
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const base = `http://127.0.0.1:${models.address().port}`;
  const local = (model) => MODEL_CATALOG[model].map((asset) => ({ ...asset, revision: "local-fixture", url: `${base}/models/local-fixture/${asset.name}` }));
  const catalog = { ...MODEL_CATALOG, aria: local("aria"), "phrase-transcription": local("phrase-transcription") };
  await browser.route("**/src/model-catalog.ts", (route) => route.fulfill({ contentType: "text/javascript", body: `export const MODEL_CATALOG = ${JSON.stringify(catalog)};` }));
  await browser.route("**/src/piano-samples.ts", (route) => route.fulfill({ contentType: "text/javascript",
    body: `export const SAMPLE_REVISION = "local-fixture"; export const PIANO_SAMPLES = ${JSON.stringify([entry])};` }));
  await browser.route("https://raw.githubusercontent.com/**/local-fixture/samples/piano/C4.mp3", (route) => route.fulfill({ body: sample,
    headers: { "Content-Type": "audio/mpeg", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" } }));
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => process.stderr.write(`Page ${message.type()}: ${message.text()}\n`));
  await page.addInitScript(() => {
    window.__duetTest = { audio: null, destination: null, providers: [] };
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => { if (data.value?.provider) window.__duetTest.providers.push(data.value.provider); });
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 16000 }), destination = audio.createMediaStreamDestination();
      await audio.resume();
      if (audio.state !== "running") throw new Error("The fake microphone did not start");
      Object.assign(window.__duetTest, { audio, destination });
      return destination.stream;
    };
    navigator.mediaDevices.enumerateDevices = async () => [];
  });
  await page.goto(`http://127.0.0.1:${site.port}/`);
  await page.waitForFunction(() => document.querySelector("#practiceTitle")?.textContent === "C major scale", null, { timeout: 30000 });
  await page.locator("#duetMode").click();
  await page.locator("#start").click();
  await page.waitForFunction(() => window.__duetTest.audio && window.__duetTest.destination);
  const staticBase = `/@fs${resolve("src/piano_duet/static")}`;
  const waitTurn = async (number) => page.waitForFunction((turn) => document.querySelector("#turnCount")?.textContent.includes(`${turn} EXCHANGES`)
    || !document.querySelector("#error").hidden, number, { timeout: 120000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({ status: document.querySelector("#status")?.textContent, timing: document.querySelector("#timing")?.textContent,
      message: document.querySelector("#message")?.textContent, error: document.querySelector("#error")?.textContent,
      download: document.querySelector(".asset-download")?.textContent, providers: window.__duetTest.providers }));
    throw new Error(`${error}: ${JSON.stringify({ state, errors })}`);
  });
  const play = async () => page.evaluate(async (path) => {
    const { PianoSound } = await import(`${path}/audio.mjs`);
    const { audio, destination } = window.__duetTest;
    const piano = new PianoSound(audio);
    await piano.load();
    const start = audio.currentTime + 2;
    for (const [index, pitch] of [60, 64, 67, 72].entries()) piano.play({ pitch, start: 0, duration: 0.35, velocity: 90 }, start + index * 0.5, audio, destination);
  }, staticBase);
  await play();
  await waitTurn("01");
  const result = await page.evaluate(async (path) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    const profile = await localRequest("/api/profile");
    return { turn: document.querySelector("#turnCount").textContent, timing: document.querySelector("#timing").textContent,
      error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent,
      providers: window.__duetTest.providers, attempt: profile.recent[0] };
  }, staticBase);
  if (result.error) throw new Error(result.error);
  assert.deepEqual(errors, []);
  assert.ok(result.turn.includes("01 EXCHANGES"));
  assert.ok(result.providers.length >= 2 && result.providers.every((provider) => provider === "webgpu"));
  assert.equal(result.attempt?.mode, "duet");
  assert.ok(result.attempt.note_count >= 3);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.startsWith("Your turn"), null, { timeout: 30000 });
  await play();
  await waitTurn("02");
  const again = await page.evaluate(async (path) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    const profile = await localRequest("/api/profile");
    return { turn: document.querySelector("#turnCount").textContent, timing: document.querySelector("#timing").textContent,
      error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent, recent: profile.recent };
  }, staticBase);
  if (again.error) throw new Error(again.error);
  assert.ok(again.turn.includes("02 EXCHANGES"));
  assert.ok(again.recent.length >= 2 && again.recent.slice(0, 2).every((attempt) => attempt.mode === "duet" && attempt.note_count >= 3));
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.startsWith("Your turn"), null, { timeout: 30000 });
  await page.locator("#learningMode").click();
  await play();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Your turn. Play back the target."
    || !document.querySelector("#error").hidden, null, { timeout: 120000 });
  const idea = await page.evaluate(() => ({ error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent,
    analysis: document.querySelectorAll("#surpriseRows tr").length }));
  if (idea.error) throw new Error(idea.error);
  assert.ok(idea.analysis >= 3);
  await play();
  await page.waitForFunction(() => !document.querySelector("#learningResult").hidden || !document.querySelector("#error").hidden,
    null, { timeout: 120000 });
  const variation = await page.evaluate(async (path) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    const profile = await localRequest("/api/profile");
    return { score: document.querySelector("#learningScore").textContent,
      error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent, recent: profile.recent };
  }, staticBase);
  if (variation.error) throw new Error(variation.error);
  assert.ok(variation.score.includes("/ 100"));
  assert.ok(variation.recent.length >= 2 && variation.recent.slice(0, 2).every((attempt) => attempt.mode === "learning" && attempt.note_count >= 3));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ providers: result.providers, notes: result.attempt.note_count, cold: result.timing, warm: again.timing,
    variationNotes: idea.analysis, variationScore: variation.score }));
} finally {
  await browser?.close();
  await profile.cleanup();
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
