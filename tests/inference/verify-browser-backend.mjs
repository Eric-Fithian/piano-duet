import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { startServer } from "./server.mjs";

const model = process.argv[2] ?? "live-transcription";
if (!["aria", "live-transcription"].includes(model)) throw new Error("Expected aria or live-transcription");
const preference = process.argv[3] ?? "auto";
if (!["auto", "wasm"].includes(preference)) throw new Error("Expected auto or wasm");
const browserName = process.argv[4] ?? "chrome";
if (!["chrome", "webkit"].includes(browserName)) throw new Error("Expected chrome or webkit");
const paths = model === "aria" ? {
  graph: ".cache/models/aria/onnx-int4-block64/model.onnx",
  weights: ".cache/models/aria/onnx-int4-block64/model.onnx.data",
} : {
  ...(preference === "wasm" ? { graph: ".cache/browser-inference/transcription.onnx" } : {}),
  convolution: ".cache/browser-inference/transcription-convolution-fp32.onnx",
  recurrent: ".cache/browser-inference/transcription-recurrent.onnx",
};
const fixture = JSON.parse(await readFile(model === "aria" ? ".cache/models/aria/onnx-int4-block64/parity.json"
  : ".cache/browser-inference/transcription.json", "utf8"));
const server = await startServer();
const profile = await mkdtemp(join(tmpdir(), "piano-duet-inference-"));
const context = await (browserName === "chrome" ? chromium : webkit).launchPersistentContext(profile,
  browserName === "chrome" ? { channel: "chrome", headless: true } : { headless: true });
const page = await context.newPage();
const files = [];
for (const [role, path] of Object.entries(paths)) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const size = (await stat(path)).size;
  const name = model === "aria" ? role === "graph" ? "model.onnx" : "model.onnx.data" : `${role}.onnx`;
  const url = `http://127.0.0.1:${server.address().port}/models/local-fixture/${name}`;
  files.push({ model, role, name, revision: "local-fixture", url,
    sha256: hash.digest("hex"), bytes: size });
}
await page.goto("http://127.0.0.1:5173/test/inference.html");
await page.waitForFunction(() => typeof window.createBrowserInference === "function");
const result = await page.evaluate(async ({ files, fixture, model, preference }) => {
  const progress = [];
  const backend = window.createBrowserInference({ [model]: files }, preference);
  const session = await backend.createSession(model, (entry) => progress.push(entry));
  const provider = session.provider;
  if (model === "aria") {
    const outputs = [];
    for (const [index, step] of fixture.steps.entries()) {
      const result = await session.run({ tokens: step.tokens, reset: index === 0 });
      outputs.push(Array.from(result.logits));
    }
    const allTokens = fixture.steps.flatMap((step) => step.tokens);
    const full = await session.run({ tokens: allTokens, reset: true });
    await session.close();
    return { outputs, full: Array.from(full.logits), provider, progress };
  }
  const result = await session.run({ audio: Float32Array.from(fixture.audio), sampleRate: 16000, threshold: 0.8 });
  await session.close();
  return { ...result, provider, progress };
}, { files, fixture, model, preference });
if (preference === "wasm") assert.equal(result.provider, "wasm");
if (model === "aria") {
  const last = result.outputs.at(-1);
  const maxError = Math.max(...last.map((value, index) => Math.abs(value - result.full[index])));
  assert.ok(maxError < 0.01, `Cached and full Aria logits differ by ${maxError}`);
  for (const [index, actual] of result.outputs.entries()) {
    const expected = fixture.steps[index].mlx_logits;
    const dot = actual.reduce((sum, value, position) => sum + value * expected[position], 0);
    const norm = Math.sqrt(actual.reduce((sum, value) => sum + value * value, 0)
      * expected.reduce((sum, value) => sum + value * value, 0));
    assert.ok(dot / norm > 0.995);
  }
  console.log(JSON.stringify({ provider: result.provider, cachedLogitError: maxError, steps: result.outputs.length }));
} else {
  assert.equal(result.notes.length, fixture.notes.length);
  for (let index = 0; index < result.notes.length; index++) {
    assert.equal(result.notes[index].pitch, fixture.notes[index].pitch);
    assert.ok(Math.abs(result.notes[index].start - fixture.notes[index].start) <= 0.0002);
  }
  console.log(JSON.stringify({ provider: result.provider, notes: result.notes, progressEvents: result.progress.length }, null, 2));
}
assert.ok(result.progress.some((entry) => entry.received === entry.total));
await context.close();
await rm(profile, { recursive: true, force: true });
await new Promise((resolve) => server.close(resolve));
