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
const phraseProvider = process.env.PIANO_CREATIVE_PHRASE_PROVIDER ?? provider;
if (![provider, phraseProvider].every((value) => ["webgpu", "wasm"].includes(value))) throw new Error("Choose webgpu or wasm for the creative microphone test");
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
  await page.addInitScript(({ selectedProvider, selectedPhraseProvider }) => {
    window.__duetTest = { audio: null, destination: null, providers: [], captures: [], events: [], progress: 0 };
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
          if (data.value?.provider) window.__duetTest.providers.push({ model: this.model, provider: data.value.provider });
          if (this.model === "phrase-transcription" && data.value?.notes) console.info(`Phrase notes: ${JSON.stringify(data.value.notes)}`);
          if (data.progress || data.value?.provider || data.value?.logits || data.value?.notes) window.__duetTest.progress++;
        });
      }
      postMessage(message, ...args) {
        if (message.action === "open") {
          this.model = message.model;
          if ((message.model === "aria" && selectedProvider === "wasm")
              || (message.model === "phrase-transcription" && selectedPhraseProvider === "wasm")) message = { ...message, preference: "wasm" };
        }
        if (this.model === "phrase-transcription" && message.action === "run") {
          const audio = message.input.audio, rms = Math.sqrt(audio.reduce((sum, value) => sum + value * value, 0) / audio.length);
          const capture = { samples: audio.length, sampleRate: message.input.sampleRate, seconds: audio.length / message.input.sampleRate,
            rms, expected: window.__duetTest.expected };
          window.__duetTest.captures.push(capture);
          console.info(`Phrase PCM: ${JSON.stringify(capture)}`);
        }
        return super.postMessage(message, ...args);
      }
    };
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#start") || window.__duetTest.audio) return;
      const audio = new AudioContext({ sampleRate: 16000 }), destination = audio.createMediaStreamDestination();
      Object.assign(window.__duetTest, { audio, destination, ready: audio.resume() });
    }, true);
    const mediaDevices = Object.getPrototypeOf(navigator.mediaDevices);
    Object.defineProperty(mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const { audio, destination, ready } = window.__duetTest;
      if (!audio || !destination || !ready) throw new Error("The fake microphone needs a start gesture");
      await ready;
      if (audio.state !== "running") throw new Error("The fake microphone did not start");
      return destination.stream;
    } });
    Object.defineProperty(mediaDevices, "enumerateDevices", { configurable: true, value: async () => [] });
  }, { selectedProvider: provider, selectedPhraseProvider: phraseProvider });
  await page.goto(`http://127.0.0.1:${site.port}/`);
  await page.waitForFunction(() => document.querySelector("#practiceTitle")?.textContent === "C major scale", null, { timeout: 30000 });
  await page.locator("#duetMode").click();
  await page.locator("#openSettings").click();
  await page.locator("#length").evaluate((input) => { input.value = "2"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await page.locator("#length").inputValue(), "2", await diagnostic("Duet reply length did not change to two seconds"));
  await page.locator('[data-close="settingsDialog"]').click();
  const staticBase = `/@fs${resolve("src/piano_duet/static")}`;
  await page.evaluate(async (path) => {
    const { PianoSound, PhraseDetector } = await import(`${path}/audio.mjs`);
    const audible = Object.getOwnPropertyDescriptor(PianoSound.prototype, "audibleUntil");
    if (!audible?.get) throw new Error("The piano guard is unavailable to the test");
    Object.defineProperty(PianoSound.prototype, "audibleUntil", { configurable: true, get() {
      const until = audible.get.call(this), value = this.context.currentTime < until, test = window.__duetTest;
      if (this.context !== test.audio) {
        const guard = { audible: value, at: performance.now(), outputTime: this.context.currentTime,
          outputUntil: this.until, microphoneTime: test.audio?.currentTime ?? null };
        if (test.guard?.audible !== value) test.events.push({ type: "guard", ...guard });
        test.guard = guard;
      }
      return until;
    } });
    const feed = PhraseDetector.prototype.feed;
    PhraseDetector.prototype.feed = function (chunk) {
      const active = this.active, result = feed.call(this, chunk);
      if (active !== this.active || result.phrase) window.__duetTest.events.push({ type: "detector", active: this.active,
        samples: result.phrase?.length ?? this.samples, rms: result.rms, microphoneTime: window.__duetTest.audio?.currentTime });
      return result;
    };
  }, staticBase);
  await page.locator("#start").click();
  await page.waitForFunction(() => window.__duetTest.audio && window.__duetTest.destination);
  const waitForListening = async (label) => {
    await page.waitForFunction(() => document.querySelector("#status")?.textContent.startsWith("Your turn"), null, { timeout: 30000 });
    const observedAt = await page.evaluate(() => performance.now());
    await page.waitForFunction((after) => window.__duetTest.guard?.at >= after && !window.__duetTest.guard.audible, observedAt, { timeout: 30000 });
    await page.waitForTimeout(250);
    const ready = await page.evaluate(() => ({ status: document.querySelector("#status")?.textContent, guard: window.__duetTest.guard }));
    assert.ok(ready.status?.startsWith("Your turn") && ready.guard?.audible === false,
      await diagnostic(`${label}: microphone-ready signal did not remain visible: ${JSON.stringify(ready)}`));
    process.stderr.write(`${label}: microphone-ready signal ${JSON.stringify(ready)}\n`);
  };
  const waitForProgress = (label, kind, turn) => waitForCreativeProgress({ label, diagnostic, errors,
    pause: () => page.waitForTimeout(1000), read: () => page.evaluate(({ kind, turn }) => {
        const error = document.querySelector("#error"), status = document.querySelector("#status")?.textContent;
        return { status, timing: document.querySelector("#timing")?.textContent, error: error.hidden ? null : error.textContent,
          download: document.querySelector(".asset-download")?.textContent, providers: window.__duetTest.providers,
          progress: window.__duetTest.progress,
          done: kind === "duet" ? document.querySelector("#turnCount")?.textContent.includes(`${turn} EXCHANGES`)
            : kind === "idea" ? status === "Your turn. Play back the target." : !document.querySelector("#learningResult").hidden };
    }, { kind, turn }) });
  const play = async (pitches = [60, 64, 67, 72], spacing = 0.5, duration = 0.35) => {
    const scheduled = await page.evaluate(async ({ path, pitches, spacing, duration }) => {
      const { PianoSound } = await import(`${path}/audio.mjs`);
      const { audio, destination } = window.__duetTest;
      const piano = new PianoSound(audio);
      await piano.load();
      const status = document.querySelector("#status")?.textContent;
      if (!status?.startsWith("Your turn")) throw new Error(`Microphone was not ready when piano playback was scheduled: ${status}`);
      const start = audio.currentTime + 0.5;
      window.__duetTest.expected = { pitches, performanceSeconds: (pitches.length - 1) * spacing + duration, sampleRate: 16000 };
      for (const [index, pitch] of pitches.entries()) piano.play({ pitch, start: 0, duration, velocity: 90 }, start + index * spacing, audio, destination);
      return { scheduled: start, audioTime: audio.currentTime, status, pitches, guard: window.__duetTest.guard };
    }, { path: staticBase, pitches, spacing, duration });
    process.stderr.write(`Scheduled synthetic piano: ${JSON.stringify(scheduled)}\n`);
  };
  await waitForListening("First Duet phrase");
  await play();
  process.stderr.write(`Waiting for first Duet exchange at ${Math.round(performance.now() - started)} ms\n`);
  await waitForProgress("First Duet exchange", "duet", "01");
  process.stderr.write(`First Duet capture trace: ${JSON.stringify(await page.evaluate(() => window.__duetTest.events.splice(0)))}\n`);
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
  assert.ok(result.providers.some((actual) => actual.model === "aria" && actual.provider === provider)
    && result.providers.some((actual) => actual.model === "phrase-transcription" && actual.provider === phraseProvider),
    await diagnostic(`Duet used unexpected inference providers ${JSON.stringify(result.providers)}`));
  assert.equal(result.attempt?.mode, "duet", await diagnostic(`First Duet attempt was not saved: ${JSON.stringify(result.attempt)}`));
  assert.ok(result.attempt.note_count >= 3, await diagnostic(`First Duet take has too few notes: ${JSON.stringify(result.attempt)}`));
  await waitForListening("Second Duet phrase");
  await play();
  process.stderr.write(`Waiting for second Duet exchange at ${Math.round(performance.now() - started)} ms\n`);
  await waitForProgress("Second Duet exchange", "duet", "02");
  process.stderr.write(`Second Duet capture trace: ${JSON.stringify(await page.evaluate(() => window.__duetTest.events.splice(0)))}\n`);
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
  await waitForListening("Variations mode switch");
  await page.locator("#learningMode").click();
  await waitForListening("Variations idea");
  await play([60, 64, 67], 0.7, 0.45);
  process.stderr.write(`Waiting for Variations idea at ${Math.round(performance.now() - started)} ms\n`);
  await waitForProgress("Variations idea", "idea");
  const idea = await page.evaluate(() => ({ error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent,
    analysis: document.querySelectorAll("#surpriseRows tr").length }));
  if (idea.error) throw new Error(idea.error);
  assert.ok(idea.analysis >= 2, await diagnostic(`Variations idea has too few analyzed notes: ${JSON.stringify(idea)}`));
  await waitForListening("Variations playback");
  await play([60, 64, 67], 0.7, 0.45);
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
