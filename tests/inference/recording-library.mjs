import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";

const models = await startServer();
const site = await startTestServer();
const profile = await mkdtemp(".cache/browser-inference/library-profile-");
const browser = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"] });
let downloads = 0;
const realHub = process.env.PIANO_REAL_HUB === "1";
const microphone = process.env.PIANO_TEST_MIC === "1";
try {
  const page = await browser.newPage();
  if (microphone) await page.addInitScript((url) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 44100 });
      const destination = context.createMediaStreamDestination();
      window.syntheticMicrophoneContext = context;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Synthetic piano audio is unavailable");
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      const player = context.createBufferSource(); player.buffer = buffer; player.connect(destination);
      await context.resume(); player.start(context.currentTime + 0.25);
      return destination.stream;
    };
  }, `http://127.0.0.1:${models.address().port}/fixtures/audio/mic-piano.wav`);
  page.on("console", (message) => process.stderr.write(`${message.type()}: ${message.text()}\n`));
  page.on("pageerror", (error) => process.stderr.write(`${error}\n`));
  await browser.route("https://huggingface.co/ericfithian/**", (route) => {
    const url = new URL(route.request().url()), name = url.pathname.split("/").at(-1);
    const score = url.pathname.includes("piano-duet-score-onnx"), recording = url.pathname.includes("piano-duet-recording-transcription-onnx");
    if (!score && !recording) return route.continue();
    downloads++;
    if (realHub) return route.continue();
    const path = score ? `/models/score/${name}` : `/models/local-fixture/recording-${name}`;
    return route.fulfill({ status: 302, headers: { location: `http://127.0.0.1:${models.address().port}${path}`,
      "access-control-allow-origin": "*" } });
  });
  await page.goto(`http://127.0.0.1:${site.port}/`);
  await page.locator("#sheetMusic svg").first().waitFor({ timeout: 30000 });
  await page.locator("#modeMenuButton").click();
  await page.locator("#libraryMode").click();
  await page.locator("#importAudio").waitFor({ state: "visible" });
  const importOnce = async (count) => {
    const started = Date.now();
    await page.locator(microphone ? "#recordAudio" : "#importAudio").click();
    if (microphone) {
      await page.locator("#recordingToggle").click();
      await page.getByText("Stop recording", { exact: true }).waitFor({ timeout: 15000 });
      await page.waitForTimeout(7600);
      await page.locator("#recordingToggle").click();
      await page.getByText("Recording ready", { exact: true }).waitFor({ timeout: 15000 });
    } else await page.locator("#recordingFile").setInputFiles(".cache/browser-inference/recording-three-minutes.wav");
    assert.equal(await page.locator("#recordingRights").isChecked(), false);
    await page.locator("#recordingRights").check();
    await page.locator("#recordingGo").click();
    await page.waitForFunction(() => document.querySelector("#recordingImportStatus")?.textContent === "Score saved to your library"
      || !document.querySelector("#recordingError")?.hidden, null, { timeout: realHub ? 600000 : 180000 });
    if (await page.locator("#recordingError").isVisible()) throw new Error(await page.locator("#recordingError").textContent());
    await page.waitForFunction((expected) => document.querySelectorAll("#songRows .song-row").length === expected, count, { timeout: 15000 });
    return Date.now() - started;
  };
  const firstMs = await importOnce(1), firstDownloads = downloads;
  await page.reload();
  await page.locator("#importAudio").waitFor({ state: "visible", timeout: 30000 });
  const single = realHub || microphone;
  const cachedMs = single ? null : await importOnce(2), cachedDownloads = downloads;
  const warmMs = single ? null : await importOnce(3);
  assert.equal(firstDownloads, 6);
  assert.equal(cachedDownloads, firstDownloads);
  assert.equal(downloads, firstDownloads);
  await page.reload();
  await page.locator("#importAudio").waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await page.locator("#songRows .song-row").count(), single ? 1 : 3);
  console.log(JSON.stringify({ firstMs, cachedMs, warmMs, firstDownloads, cachedDownloads, warmDownloads: downloads,
    modelFiles: realHub ? "public Hugging Face catalog assets" : "local hash-verified catalog assets", microphone, saved: true, persisted: true }));
} finally {
  await browser.close(); await rm(profile, { recursive: true, force: true }); site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
