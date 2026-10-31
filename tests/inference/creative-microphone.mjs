import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { MODEL_CATALOG } from "../../site/app/src/model-catalog.ts";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";
import { browserProfile } from "./browser-profile.mjs";
import { waitForCreativeProgress } from "./creative-progress.mjs";

const started = performance.now();
let page;
async function diagnostic(condition) {
  const state = page ? await page.evaluate(() => ({ status: document.querySelector("#status")?.textContent,
    error: document.querySelector("#error")?.hidden ? null : document.querySelector("#error")?.textContent }))
    : { status: "page not opened", error: null };
  return `${condition}; elapsed ${Math.round(performance.now() - started)} ms; ${JSON.stringify(state)}`;
}
const provider = process.env.PIANO_CREATIVE_PROVIDER ?? "webgpu";
if (!["webgpu", "wasm"].includes(provider)) throw new Error("Choose webgpu or wasm for the creative microphone test");
const sample = await readFile(".cache/browser-inference/C4.mp3");
const entry = { pitch: 60, file: "C4.mp3", sha256: "a265c8cfd4140cf27b55054b4953b6c691fce3523530ca8ae0faed5e4cd39063", bytes: 239164 };
assert.equal(sample.length, entry.bytes, await diagnostic("Piano sample size differs"));
assert.equal(createHash("sha256").update(sample).digest("hex"), entry.sha256, await diagnostic("Piano sample hash differs"));
const profile = await browserProfile();
const models = await startServer({ port: Number(process.env.PIANO_MODEL_PORT ?? 0) });
const site = await startTestServer(false, Number(process.env.PIANO_SITE_PORT ?? 0));
let browser;
try {
  browser = await chromium.launchPersistentContext(profile.path, { channel: "chrome", headless: true, permissions: ["microphone"],
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const base = `http://127.0.0.1:${models.address().port}`;
  const local = (model) => MODEL_CATALOG[model].map((asset) => ({ ...asset, revision: "local-fixture", url: `${base}/models/local-fixture/${asset.name}` }));
  const catalog = process.env.PIANO_CREATIVE_REMOTE_MODELS === "1" ? MODEL_CATALOG
    : { ...MODEL_CATALOG, aria: local("aria"), "phrase-transcription": local("phrase-transcription") };
  await browser.route("**/src/model-catalog.ts", (route) => route.fulfill({ contentType: "text/javascript", body: `export const MODEL_CATALOG = ${JSON.stringify(catalog)};` }));
  await browser.route("**/src/piano-samples.ts", (route) => route.fulfill({ contentType: "text/javascript",
    body: `export const SAMPLE_REVISION = "local-fixture"; export const PIANO_SAMPLES = ${JSON.stringify([entry])};` }));
  await browser.route("https://raw.githubusercontent.com/**/local-fixture/samples/piano/C4.mp3", (route) => route.fulfill({ body: sample,
    headers: { "Content-Type": "audio/mpeg", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" } }));
  page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => process.stderr.write(`Page ${message.type()}: ${message.text()}\n`));
  await page.addInitScript((selectedProvider) => {
    window.__duetTest = { audio: null, destination: null, providers: [], progress: 0 };
    document.addEventListener("DOMContentLoaded", () => {
      const input = document.querySelector("#length");
      if (!input) throw new Error("The reply length control is missing");
      input.value = "2";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.value?.provider) window.__duetTest.providers.push(data.value.provider);
          if (data.progress || data.value?.provider || data.value?.logits || data.value?.notes) window.__duetTest.progress++;
        });
      }
      postMessage(message, ...args) {
        if (selectedProvider === "wasm" && message.action === "open" && ["aria", "phrase-transcription"].includes(message.model)) {
          message = { ...message, preference: "wasm" };
        }
        return super.postMessage(message, ...args);
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
  }, provider);
  await page.goto(`http://127.0.0.1:${site.port}/`);
  await page.waitForFunction(() => document.querySelector("#practiceTitle")?.textContent === "C major scale", null, { timeout: 30000 });
  await page.locator("#duetMode").click();
  await page.locator("#openSettings").click();
  await page.locator("#length").evaluate((input) => { input.value = "2"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.locator("#length").inputValue(), "2", await diagnostic("Duet reply length did not change to two seconds"));
  await page.locator('[data-close="settingsDialog"]').click();
  await page.locator("#start").click();
  await page.waitForFunction(() => window.__duetTest.audio && window.__duetTest.destination);
  const staticBase = `/@fs${resolve("src/piano_duet/static")}`;
  const waitForProgress = (label, kind, turn) => waitForCreativeProgress({ label, diagnostic, errors,
    pause: () => page.waitForTimeout(1000), read: () => page.evaluate(({ kind, turn }) => {
        const error = document.querySelector("#error"), status = document.querySelector("#status")?.textContent;
        return { status, timing: document.querySelector("#timing")?.textContent, error: error.hidden ? null : error.textContent,
          download: document.querySelector(".asset-download")?.textContent, providers: window.__duetTest.providers,
          progress: window.__duetTest.progress,
          done: kind === "duet" ? document.querySelector("#turnCount")?.textContent.includes(`${turn} EXCHANGES`)
            : kind === "idea" ? status === "Your turn. Play back the target." : !document.querySelector("#learningResult").hidden };
    }, { kind, turn }) });
  const play = async (pitches = [60, 64, 67, 72]) => page.evaluate(async ({ path, pitches }) => {
    const { PianoSound } = await import(`${path}/audio.mjs`);
    const { audio, destination } = window.__duetTest;
    const piano = new PianoSound(audio);
    await piano.load();
    const start = audio.currentTime + 2;
    for (const [index, pitch] of pitches.entries()) piano.play({ pitch, start: 0, duration: 0.35, velocity: 90 }, start + index * 0.5, audio, destination);
  }, { path: staticBase, pitches });
  await play();
  process.stderr.write(`Waiting for first Duet exchange at ${Math.round(performance.now() - started)} ms\n`);
  await waitForProgress("First Duet exchange", "duet", "01");
  const result = await page.evaluate(async (path) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    const profile = await localRequest("/api/profile");
    return { turn: document.querySelector("#turnCount").textContent, timing: document.querySelector("#timing").textContent,
      error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent,
      providers: window.__duetTest.providers, attempt: profile.recent[0] };
  }, staticBase);
  if (result.error) throw new Error(result.error);
  assert.deepEqual(errors, [], await diagnostic("Duet page raised an exception"));
  assert.ok(result.turn.includes("01 EXCHANGES"), await diagnostic("First Duet exchange was not shown"));
  assert.ok(result.providers.length >= 2 && result.providers.every((actual) => actual === provider),
    await diagnostic(`Duet used unexpected inference providers ${JSON.stringify(result.providers)}`));
  assert.equal(result.attempt?.mode, "duet", await diagnostic(`First Duet attempt was not saved: ${JSON.stringify(result.attempt)}`));
  assert.ok(result.attempt.note_count >= 3, await diagnostic(`First Duet take has too few notes: ${JSON.stringify(result.attempt)}`));
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.startsWith("Your turn"), null, { timeout: 30000 });
  await play();
  process.stderr.write(`Waiting for second Duet exchange at ${Math.round(performance.now() - started)} ms\n`);
  await waitForProgress("Second Duet exchange", "duet", "02");
  const again = await page.evaluate(async (path) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    const profile = await localRequest("/api/profile");
    return { turn: document.querySelector("#turnCount").textContent, timing: document.querySelector("#timing").textContent,
      error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent, recent: profile.recent };
  }, staticBase);
  if (again.error) throw new Error(again.error);
  assert.ok(again.turn.includes("02 EXCHANGES"), await diagnostic("Second Duet exchange was not shown"));
  assert.ok(again.recent.length >= 2 && again.recent.slice(0, 2).every((attempt) => attempt.mode === "duet" && attempt.note_count >= 3),
    await diagnostic(`Duet attempts were not saved with enough notes: ${JSON.stringify(again.recent.slice(0, 2))}`));
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.startsWith("Your turn"), null, { timeout: 30000 });
  await page.locator("#learningMode").click();
  await play([60, 67]);
  process.stderr.write(`Waiting for Variations idea at ${Math.round(performance.now() - started)} ms\n`);
  await waitForProgress("Variations idea", "idea");
  const idea = await page.evaluate(() => ({ error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent,
    analysis: document.querySelectorAll("#surpriseRows tr").length }));
  if (idea.error) throw new Error(idea.error);
  assert.ok(idea.analysis >= 2, await diagnostic(`Variations idea has too few analyzed notes: ${JSON.stringify(idea)}`));
  await play([60, 67]);
  process.stderr.write(`Waiting for Variations playback at ${Math.round(performance.now() - started)} ms\n`);
  await waitForProgress("Variations playback", "score");
  const variation = await page.evaluate(async (path) => {
    const { localRequest } = await import(`${path}/practice.mjs`);
    const profile = await localRequest("/api/profile");
    return { score: document.querySelector("#learningScore").textContent,
      error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent, recent: profile.recent };
  }, staticBase);
  if (variation.error) throw new Error(variation.error);
  assert.ok(variation.score.includes("/ 100"), await diagnostic(`Variations score is missing: ${JSON.stringify(variation)}`));
  assert.ok(variation.recent.length >= 2 && variation.recent.slice(0, 2).every((attempt) => attempt.mode === "learning" && attempt.note_count >= 2),
    await diagnostic(`Variations attempts were not saved with enough notes: ${JSON.stringify(variation.recent.slice(0, 2))}`));
  assert.deepEqual(errors, [], await diagnostic("Creative modes raised a page exception"));
  console.log(JSON.stringify({ providers: result.providers, notes: result.attempt.note_count, cold: result.timing, warm: again.timing,
    variationNotes: idea.analysis, variationScore: variation.score }));
} finally {
  await browser?.close();
  await profile.cleanup();
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
