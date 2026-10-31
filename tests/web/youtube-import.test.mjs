import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startTestServer } from "./server.mjs";

let server, port;
before(async () => { ({ server, port } = await startTestServer()); }, { timeout: 45000 });
after(() => server.kill("SIGTERM"));

async function openForm(page) {
  await page.goto(`http://127.0.0.1:${port}/test/youtube-import.html`);
  await page.waitForFunction(() => window.youtubeTestReady);
  await page.click("#openYoutube");
  await page.fill("#youtubeUrl", "https://youtu.be/abcdefghijk");
  await page.check("#youtubeRights");
}

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} explains unsupported tab sharing and offers Record`, { timeout: 30000 }, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => { Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getDisplayMedia", { value: undefined, configurable: true }); });
      await openForm(page);
      assert.equal(await page.locator("#youtubeSupport").textContent(), "This browser can't share tab audio. Use Chrome or Edge, or play the video aloud and use Record.");
      await page.click("#youtubeRecord");
      assert.equal(await page.evaluate(() => window.recordOpened), true);
    } finally { await browser.close(); }
  });
  test(`${name} explains a shared tab without audio`, { timeout: 30000 }, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.open = () => null;
        Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getDisplayMedia", { configurable: true, value: async () => new MediaStream() });
      });
      await openForm(page); await page.click("#youtubeGo");
      await page.waitForSelector("#youtubeSupport:not([hidden])");
      const text = await page.locator("#youtubeSupport").textContent();
      assert.ok(text.includes(name === "Chromium" ? "No tab audio was shared" : "This browser can't share tab audio"));
      assert.equal(await page.evaluate(() => window.savedEvents?.length ?? 0), 0);
    } finally { await browser.close(); }
  });
}

test("Chromium captures synthetic tab audio and saves a YouTube song", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const open = window.open.bind(window);
      window.open = (url) => { window.openedVideo = String(url); return open("about:blank", "_blank", "noopener,noreferrer"); };
      Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getDisplayMedia", { configurable: true, value: async (options) => {
        window.captureOptions = options;
        const source = new AudioContext();
        const oscillator = source.createOscillator(), destination = source.createMediaStreamDestination();
        oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
        await source.resume(); window.syntheticSource = source;
        const canvas = document.createElement("canvas");
        const video = canvas.captureStream().getVideoTracks()[0]; window.sharedVideo = video;
        destination.stream.addTrack(video);
        return destination.stream;
      } });
    });
    await openForm(page);
    await page.fill("#youtubeVideoTitle", "Piano étude"); await page.fill("#youtubeChannel", "A pianist");
    await page.click("#youtubeGo"); await page.waitForSelector("#youtubeStop:not([hidden])");
    assert.equal(await page.evaluate(() => window.sharedVideo.readyState), "ended");
    await page.waitForTimeout(700); await page.click("#youtubeStop");
    await page.waitForFunction(() => window.savedEvents?.length === 1);
    const result = await page.evaluate(() => ({ audio: window.receivedAudio, event: window.savedEvents[0],
      options: window.captureOptions, opened: window.openedVideo }));
    assert.ok(result.audio.samples > 10000); assert.ok(result.audio.peak > 0.1);
    assert.equal(result.event.payload.song.title, "Piano étude"); assert.equal(result.event.payload.song.artist, "A pianist");
    assert.equal(result.event.payload.song.source, "YouTube"); assert.equal(result.event.payload.song.transcribed, true);
    assert.equal(result.event.payload.song.url, "https://youtu.be/abcdefghijk");
    assert.equal(result.opened, "https://youtu.be/abcdefghijk");
    assert.equal(await page.locator("#recordingImportStatus").textContent(), "Score saved to your library");
    assert.deepEqual(result.options, { video: true, audio: true, selfBrowserSurface: "exclude", preferCurrentTab: false, surfaceSwitching: "exclude" });
    assert.ok(result.event.payload.song.notes.length > 0);
  } finally { await browser.close(); }
});

test("cancelling the picker quietly returns to the dialog", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.open = () => null;
      Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getDisplayMedia", { configurable: true, value: async () => { throw new DOMException("Cancelled", "NotAllowedError"); } });
    });
    await openForm(page); await page.click("#youtubeGo");
    await page.waitForFunction(() => !document.querySelector("#youtubeGo").disabled);
    assert.equal(await page.locator("#youtubeDialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#youtubeError").isVisible(), false);
    assert.equal(await page.evaluate(() => window.savedEvents?.length ?? 0), 0);
  } finally { await browser.close(); }
});

test("stopping sharing writes the captured score and cancelling discards it", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.open = () => null;
      Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getDisplayMedia", { configurable: true, value: async () => {
        const source = new AudioContext(), oscillator = source.createOscillator(), destination = source.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await source.resume();
        window.syntheticSource = source; window.sharedAudio = destination.stream.getAudioTracks()[0];
        return destination.stream;
      } });
    });
    await openForm(page); await page.click("#youtubeGo"); await page.waitForSelector("#youtubeStop:not([hidden])");
    await page.waitForTimeout(400);
    await page.evaluate(() => window.sharedAudio.dispatchEvent(new Event("ended")));
    await page.waitForFunction(() => window.savedEvents?.length === 1);
    await page.click("#openYoutube"); await page.fill("#youtubeUrl", "https://youtu.be/abcdefghijk");
    await page.check("#youtubeRights"); await page.click("#youtubeGo"); await page.waitForSelector("#youtubeStop:not([hidden])");
    await page.click('[data-close="youtubeDialog"]');
    await page.waitForFunction(() => window.sharedAudio.readyState === "ended");
    assert.equal(await page.evaluate(() => window.savedEvents.length), 1);
    await page.click("#openYoutube"); await page.check("#youtubeRights"); await page.click("#youtubeGo");
    await page.waitForSelector("#youtubeStop:not([hidden])");
    await page.click('[data-close="youtubeDialog"]');
    assert.equal(await page.evaluate(() => window.savedEvents.length), 1);
  } finally { await browser.close(); }
});

test("capture stops at the 15-minute limit", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 900000 ? 700 : delay, ...args);
      window.open = () => null;
      Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getDisplayMedia", { configurable: true, value: async () => {
        const source = new AudioContext(), oscillator = source.createOscillator(), destination = source.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await source.resume(); window.syntheticSource = source;
        window.sharedAudio = destination.stream.getAudioTracks()[0]; return destination.stream;
      } });
    });
    await openForm(page); await page.click("#youtubeGo"); await page.waitForSelector("#youtubeStop:not([hidden])");
    await page.waitForFunction(() => window.savedEvents?.length === 1);
    assert.equal(await page.evaluate(() => window.sharedAudio.readyState), "ended");
  } finally { await browser.close(); }
});
