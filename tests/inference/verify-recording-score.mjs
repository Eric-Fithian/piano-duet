import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";

const models = await startServer();
const site = await startTestServer();
const base = `http://127.0.0.1:${models.address().port}`;
const assets = [];
for (const [role, name] of [["features", "features.onnx"], ["attributes", "attributes.onnx"]]) {
  const path = `.cache/models/recording-transcription/onnx-fp32/${name}`;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assets.push({ model: "recording-transcription", role, name, revision: "local-fixture",
    url: `${base}/models/local-fixture/recording-${name}`, sha256: hash.digest("hex"), bytes: (await stat(path)).size });
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("console", (message) => process.stderr.write(`${message.type()}: ${message.text()}\n`));
page.on("pageerror", (error) => process.stderr.write(`${error}\n`));
let result;
try {
  await page.goto(`http://127.0.0.1:${site.port}/test/score-inference.html`);
  await page.waitForFunction(() => typeof window.verifyRecordingScore === "function");
  result = await page.evaluate(({ base, assets }) => window.verifyRecordingScore(base, assets), { base, assets });
  if (!result.score.tokens) throw new Error("The browser did not return score tokens");
  await writeFile(".cache/m2st/browser-score-tokens.json", JSON.stringify(result.score.tokens));
  const { tokens, ...summary } = result.score;
  console.log(JSON.stringify({ ...result, score: summary }, null, 2));
} finally {
  await browser.close();
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
assert.equal(result.recordingProvider, "wasm");
assert.ok(result.score.sourceNotes > 0);
if (result.score.inputDifferences && Object.values(result.score.inputDifferences).every((count) => count === 0)) {
  assert.ok(Object.values(result.score.mismatches).every((count) => count === 0), "Score outputs differ despite identical inputs");
}
