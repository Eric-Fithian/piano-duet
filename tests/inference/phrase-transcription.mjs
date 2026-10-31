import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";
import { browserProfile } from "./browser-profile.mjs";

const path = process.env.PIANO_PHRASE_MODEL ?? ".cache/models/transcription/piano_crnn.onnx";
const split = process.argv.includes("--split");
const preference = process.argv.includes("--wasm") ? "wasm" : "auto";
const bytes = 154206740, sha256 = "743cf9fc88d1c24e5d4cc7a47ba55abd5c52c8623274355d79a981955fbbea99";
const hash = createHash("sha256");
for await (const chunk of createReadStream(path)) hash.update(chunk);
assert.equal((await stat(path)).size, bytes);
assert.equal(hash.digest("hex"), sha256);
const expected = JSON.parse(await readFile(".cache/browser-inference/phrase-reference.json", "utf8"));
const profile = await browserProfile();
const models = await startServer({ port: Number(process.env.PIANO_MODEL_PORT ?? 0) });
const site = await startTestServer(false, Number(process.env.PIANO_SITE_PORT ?? 0));
let browser;
try {
  browser = await chromium.launchPersistentContext(profile.path, { channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.on("console", (message) => process.stderr.write(`${message.text()}\n`));
  await page.goto(`http://127.0.0.1:${site.port}/test/phrase-transcription.html`);
  await page.waitForFunction(() => typeof window.transcribePhraseFixture === "function");
  const base = `http://127.0.0.1:${models.address().port}`;
  const files = [{ model: "phrase-transcription", role: "graph", name: "piano_crnn.onnx", revision: "local-fixture", bytes, sha256,
    url: `${base}/models/local-fixture/piano_crnn.onnx` }];
  if (split) for (const [role, name] of [["convolution", "phrase-convolution.onnx"], ["recurrent", "phrase-recurrent.onnx"]]) {
    const local = `${process.env.PIANO_PHRASE_SPLIT_DIR ?? ".cache/browser-inference"}/${name}`, digest = createHash("sha256");
    for await (const chunk of createReadStream(local)) digest.update(chunk);
    files.push({ model: "phrase-transcription", role, name, revision: "local-fixture", bytes: (await stat(local)).size,
      sha256: digest.digest("hex"), url: `${base}/models/local-fixture/${name}` });
  }
  const result = await page.evaluate(({ assets, url, preferred }) => window.transcribePhraseFixture(assets, url, preferred),
    { assets: files, url: `${base}/fixtures/phrase.pcm`, preferred: preference });
  assert.equal(result.provider, split && preference === "auto" ? "webgpu" : "wasm");
  assert.equal(result.notes.length, expected.notes.length);
  for (let index = 0; index < result.notes.length; index++) {
    const actual = result.notes[index], reference = expected.notes[index];
    assert.equal(actual.pitch, reference.pitch);
    assert.equal(actual.velocity, reference.velocity);
    assert.ok(Math.abs(actual.start - reference.start) < 0.001, `onset ${index}: ${actual.start} vs ${reference.start}`);
    assert.ok(Math.abs(actual.duration - reference.duration) < 0.001, `duration ${index}: ${actual.duration} vs ${reference.duration}`);
  }
  assert.deepEqual(result.quality, expected.quality);
  console.log(JSON.stringify({ provider: result.provider, notes: result.notes.length, browserMs: result.elapsedMs, pythonMs: expected.elapsedMs }));
} finally {
  await browser?.close();
  await profile.cleanup();
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
