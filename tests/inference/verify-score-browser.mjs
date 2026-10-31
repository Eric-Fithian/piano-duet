import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";

const provider = process.argv[2] ?? "webgpu";
if (!["webgpu", "wasm"].includes(provider)) throw new Error("Choose webgpu or wasm");
const models = await startServer();
const site = await startTestServer();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("console", (message) => process.stderr.write(`${message.type()}: ${message.text()}\n`));
page.on("pageerror", (error) => process.stderr.write(`${error}\n`));
let result;
try {
  await page.goto(`http://127.0.0.1:${site.port}/test/score-inference.html`);
  await page.waitForFunction(() => typeof window.verifyScore === "function");
  result = await page.evaluate(({ base, provider, runtime }) => runtime
    ? window.verifyScoreRuntime(base, provider) : window.verifyScore(base, provider),
  { base: `http://127.0.0.1:${models.address().port}`, provider, runtime: process.env.PIANO_SCORE_RUNTIME === "1" });
  console.log(JSON.stringify({ provider, ...result }, null, 2));
} finally {
  await browser.close();
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
assert.ok(Object.values(result.mismatches).every((count) => count === 0), "Score tokens differ from the Python reference");
