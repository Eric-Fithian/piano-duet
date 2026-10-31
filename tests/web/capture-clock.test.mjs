import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";

const files = Object.fromEntries(["capture.js", "audio.mjs", "practice.mjs", "learning.mjs"]
  .map((name) => [`/${name}`, readFileSync(`src/piano_duet/static/${name}`)]));
const server = createServer((request, response) => {
  if (files[request.url]) { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(files[request.url]); return; }
  response.writeHead(200, { "Content-Type": "text/html" }); response.end("<button>Start</button>");
});
before(() => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)));
after(() => new Promise((resolve) => server.close(resolve)));

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} gates delayed microphone chunks by their capture time`, { timeout: 30000 }, async () => {
    const browser = await engine.launch({ headless: true, ...(name === "Chromium"
      ? { channel: "chromium", args: ["--autoplay-policy=no-user-gesture-required"] } : {}) });
    try {
      const page = await browser.newPage(), errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.captureProbe = { calls: 0, observed: [] };
        document.addEventListener("click", (event) => {
          if (!event.target.closest("button")) return;
          const output = new AudioContext(), input = new AudioContext({ sampleRate: 16000 });
          const destination = output.createMediaStreamDestination();
          Object.assign(window.captureProbe, { output, input, destination, ready: Promise.all([output.resume(), input.resume()]) });
        }, true);
        Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getUserMedia", { configurable: true, value: async () => {
          const probe = window.captureProbe; probe.calls++; await probe.ready;
          if (probe.output.state !== "running" || probe.input.state !== "running") throw new Error("Fake microphone contexts are not running");
          return probe.destination.stream;
        } });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.evaluate(async () => {
        const { captureAllowed, capturePerformanceTime } = await import("/audio.mjs");
        document.querySelector("button").onclick = async () => {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const probe = window.captureProbe, { output, input, destination } = probe;
          if (stream.getAudioTracks()[0].id !== destination.stream.getAudioTracks()[0].id) throw new Error("The microphone is not synthetic");
          if (output.state !== "running" || input.state !== "running") throw new Error("The capture contexts stopped");
          const oscillator = output.createOscillator(), gain = output.createGain();
          oscillator.connect(gain).connect(destination); oscillator.start();
          await input.audioWorklet.addModule("/capture.js");
          const worklet = new AudioWorkletNode(input, "piano-capture");
          input.createMediaStreamSource(stream).connect(worklet).connect(input.destination);
          Object.assign(probe, { oscillator, worklet });
          const start = output.currentTime + 0.2, release = performance.now() + (start + 0.65 - output.currentTime) * 1000;
          gain.gain.setValueAtTime(0, output.currentTime);
          gain.gain.setValueAtTime(0.4, start + 0.1); gain.gain.setValueAtTime(0, start + 0.3);
          gain.gain.setValueAtTime(0.4, start + 0.9); gain.gain.setValueAtTime(0, start + 1.1);
          worklet.port.onmessage = ({ data }) => {
            const rms = Math.sqrt(data.samples.reduce((sum, value) => sum + value * value, 0) / data.samples.length);
            if (rms <= 0.05) return;
            setTimeout(() => {
              const captured = capturePerformanceTime(data.capturedAt, input.getOutputTimestamp(), input.baseLatency);
              probe.observed.push({ allowed: captureAllowed(captured, release, -Infinity, false), delay: performance.now() - captured });
            }, 1500);
          };
        };
      });
      await page.click("button");
      await page.waitForFunction(() => window.captureProbe.observed.some((item) => item.allowed)
        && window.captureProbe.observed.some((item) => !item.allowed), null, { timeout: 15000 });
      const result = await page.evaluate(() => ({ calls: window.captureProbe.calls, output: window.captureProbe.output.state,
        input: window.captureProbe.input.state, observed: window.captureProbe.observed }));
      assert.equal(result.calls, 1);
      assert.equal(result.output, "running");
      assert.equal(result.input, "running");
      assert.ok(result.observed.every((item) => item.delay > 1000), JSON.stringify(result));
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
