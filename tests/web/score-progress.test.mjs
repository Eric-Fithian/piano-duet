import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startTestServer } from "./server.mjs";

let server, port;
before(async () => { ({ server, port } = await startTestServer()); }, { timeout: 45000 });
after(() => server?.kill("SIGTERM"));

test("score inference reports encoder and decoder progress without model files", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/test/score-progress.html`);
    await page.waitForFunction(() => typeof window.verifyScoreProgress === "function");
    const result = await page.evaluate(() => window.verifyScoreProgress());
    assert.equal(result.tokenCount, 512);
    assert.deepEqual(result.progress[0], { phase: "encoder", chunk: 0, completed: 0, total: 1 });
    assert.deepEqual(result.progress[1], { phase: "encoder", chunk: 0, completed: 1, total: 1 });
    assert.deepEqual(result.progress[2], { phase: "decoder", chunk: 0, completed: 0, total: 512 });
    assert.deepEqual(result.progress.at(-1), { phase: "decoder", chunk: 0, completed: 512, total: 512 });
    assert.equal(result.progress.length, 515);
  } finally { await browser.close(); }
});
