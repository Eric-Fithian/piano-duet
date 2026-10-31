import { chromium } from "playwright";
import { startServer } from "./server.mjs";

const server = await startServer({ referencePort: 8879 });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: [
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
] });
const results = [];
let targetTask;
const selected = process.argv[2];
if (selected && !["python", "split-fp32"].includes(selected)) throw new Error("Expected python or split-fp32");
for (const backend of selected ? [selected] : ["python", "split-fp32"]) {
  for (let trial = 0; trial < (selected ? 1 : 3); trial++) {
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    page.on("pageerror", (error) => process.stderr.write(`${backend}: ${error}\n`));
    page.on("console", (message) => { if (message.type() === "error") process.stderr.write(`${backend}: ${message.text()}\n`); });
    context.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (backend === "split-fp32" && (path === "/worker.mjs" || path.endsWith(".wasm"))) {
        process.stderr.write(`response ${response.status()} ${path} ${response.headers()["content-type"]}\n`);
      }
    });
    await context.route("**/api/practice/next", async (route) => {
      if (route.request().method() === "POST"
          && route.request().postDataJSON().focus === "reading" && !route.request().postDataJSON().after) {
        if (targetTask) await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(targetTask) });
        else {
          const response = await route.fetch();
          targetTask = await response.json();
          await route.fulfill({ response });
        }
      } else await route.continue();
    });
    await page.addInitScript((chosenBackend) => {
      const observed = { onsets: [], greens: [], tasks: [] };
      window.__latency = observed;
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, options) => {
        const response = await nativeFetch(input, options);
        if (input === "/api/practice/next" && JSON.parse(options.body).focus === "reading") {
          observed.tasks.push(await response.clone().json());
        }
        return response;
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext({ sampleRate: 16000 });
        const destination = audio.createMediaStreamDestination();
        const source = audio.createMediaStreamSource(destination.stream);
        const processor = audio.createScriptProcessor(256, 1, 1);
        const silence = audio.createGain();
        silence.gain.value = 0;
        let lastSound = -Infinity;
        processor.onaudioprocess = (event) => {
          const samples = event.inputBuffer.getChannelData(0);
          const index = samples.findIndex((sample) => Math.abs(sample) > 0.01);
          const now = performance.now();
          if (index >= 0) {
            if (now - lastSound > 400) observed.onsets.push(now - (samples.length - index) * 1000 / audio.sampleRate);
            lastSound = now;
          }
        };
        source.connect(processor).connect(silence).connect(audio.destination);
        await audio.resume();
        observed.audio = audio;
        observed.destination = destination;
        return destination.stream;
      };
      navigator.mediaDevices.enumerateDevices = async () => [];
      new MutationObserver(() => {
        if (document.querySelector(".score-read-done") && !observed.greens.length) observed.greens.push(performance.now());
      }).observe(document, { subtree: true, attributes: true, childList: true });
      if (chosenBackend === "split-fp32") {
        let worker;
        let ready;
        const pending = new Map();
        let sequence = 0;
        const call = (message) => new Promise((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          worker.postMessage({ ...message, id });
        });
        window.__prepareLive = async () => {
          observed.pageIsolated = self.crossOriginIsolated;
          worker = new Worker("/worker.mjs", { type: "module" });
          await new Promise((resolve, reject) => {
            ready = { resolve, reject };
            worker.onmessage = ({ data }) => {
              if (data.type === "ready") {
                observed.workerIsolated = data.isolated;
                ready.resolve();
                return;
              }
              const request = pending.get(data.id);
              pending.delete(data.id);
              if (data.error) request.reject(new Error(data.error));
              else request.resolve(data.value);
            };
            worker.onerror = (event) => {
              const error = new Error(`Worker failed: ${event.message} ${event.filename}:${event.lineno}`);
              ready.reject(error);
              for (const request of pending.values()) request.reject(error);
              pending.clear();
            };
          });
          return call({ action: "prepare" });
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, options) => {
          if (typeof input !== "string" || !input.startsWith("/api/reading/listen?")) return originalFetch(input, options);
          const threshold = Number(new URL(input, location.href).searchParams.get("threshold"));
          const value = await call({ action: "listen", audio: new Float32Array(options.body), threshold });
          return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
        };
      }
    }, backend);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    await page.evaluate(() => { window.__latency.tasks = []; });
    await page.locator("#modeMenuButton").click();
    await page.locator("#readingMode").click();
    await page.waitForFunction(() => document.querySelector("#readingMode").getAttribute("aria-pressed") === "true"
      && !document.querySelector("#start").disabled && window.__latency.tasks.length > 0
      && document.querySelector("#sheetMusic svg"));
    if (backend === "split-fp32") {
      process.stderr.write(`page isolated: ${await page.evaluate(() => self.crossOriginIsolated)}\n`);
      const prepared = await page.evaluate(() => Promise.race([
        window.__prepareLive(), new Promise((_, reject) => setTimeout(() => reject(new Error("Worker initialization timed out")), 20000)),
      ]));
      process.stderr.write(`worker: ${JSON.stringify(prepared)}\n`);
    }
    await page.locator("#start").click();
    await page.waitForFunction(() => window.__latency.audio && window.__latency.destination);
    await page.evaluate(async () => {
      const { PianoSound } = await import("/static/audio.mjs");
      const { audio, destination, tasks } = window.__latency;
      const piano = new PianoSound(audio);
      await piano.load();
      const pitch = tasks[0].target[0].pitch;
      piano.play({ pitch, velocity: 100, duration: 0.6 }, audio.currentTime + 1, audio, destination);
    });
    try {
      await page.waitForFunction(() => window.__latency.greens.length > 0, null, { timeout: 20000 });
    } catch (error) {
      process.stderr.write(JSON.stringify(await page.evaluate(() => ({
        observation: window.__latency, error: document.querySelector("#error")?.textContent,
        status: document.querySelector("#status")?.textContent,
        title: document.querySelector("h2")?.textContent,
        text: document.querySelector("#message")?.textContent,
      }))) + "\n");
      throw error;
    }
    const observation = await page.evaluate(() => ({ onsets: window.__latency.onsets, greens: window.__latency.greens,
      pitch: window.__latency.tasks[0].target[0].pitch }));
    const onset = observation.onsets.filter((time) => time <= observation.greens[0]).at(-1);
    if (onset === undefined) throw new Error(`${backend} produced green feedback without a captured onset`);
    results.push({ backend, trial, pitch: observation.pitch, latency_ms: observation.greens[0] - onset, onsets: observation.onsets.length });
    process.stderr.write(`${JSON.stringify(results.at(-1))}\n`);
    await context.close();
  }
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
await new Promise((resolve) => server.close(resolve));
