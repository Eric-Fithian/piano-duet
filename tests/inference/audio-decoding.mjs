import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";

const models = await startServer();
const site = await startTestServer();
const results = [];
const failures = [];
try {
  for (const [name, engine, options] of [["chrome", chromium, { channel: "chrome" }], ["webkit", webkit, {}]]) {
    const browser = await engine.launch({ ...options, headless: true });
    try {
      for (const format of ["mp3", "m4a", "flac", "webm"]) {
        const page = await browser.newPage();
        const failedResponses = [];
        page.on("console", (message) => process.stderr.write(`${name}: ${message.text()}\n`));
        page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
        await page.goto(`http://127.0.0.1:${site.port}/test/audio-decoder.html`);
        await page.waitForFunction(() => typeof window.verifyAudioDecoder === "function");
        await page.waitForLoadState("networkidle");
        const url = `http://127.0.0.1:${models.address().port}/fixtures/audio/fixture.${format}`;
        const result = await page.evaluate((address) => window.verifyAudioDecoder(address), url);
        assert.deepEqual(failedResponses, [], `Failed ${name} ${format} resources`);
        await writeFile(`.cache/audio-formats/${name}-${format}.pcm`, new Uint8Array(Float32Array.from(result.audio).buffer));
        const bytes = await readFile(`.cache/audio-formats/fixture.${format}.pcm`);
        const reference = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        const count = Math.min(reference.length, result.audio.length);
        let sum = 0, maximum = 0;
        for (let index = 0; index < count; index++) {
          const difference = result.audio[index] - reference[index];
          sum += difference * difference; maximum = Math.max(maximum, Math.abs(difference));
        }
        const summary = { browser: name, format, backend: result.backend, nativeRate: result.nativeRate,
          samples: result.audio.length, referenceSamples: reference.length, rmsError: Math.sqrt(sum / count), maxError: maximum };
        results.push(summary);
        console.log(JSON.stringify(summary));
        if (result.audio.length !== reference.length || summary.rmsError >= 0.005) failures.push(summary);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally {
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
assert.equal(results.length, 8);
assert.deepEqual(failures, [], "Audio decoding differs from the ffmpeg reference");
