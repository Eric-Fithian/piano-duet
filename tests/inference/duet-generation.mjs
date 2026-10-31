import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";
import { browserProfile } from "./browser-profile.mjs";

const profile = await browserProfile();
const models = await startServer({ port: Number(process.env.PIANO_MODEL_PORT ?? 0) });
const site = await startTestServer(false, Number(process.env.PIANO_SITE_PORT ?? 0));
let browser;
try {
  browser = await chromium.launchPersistentContext(profile.path, { channel: "chrome", headless: true });
  const files = [];
  for (const [role, name] of [["graph", "model.onnx"], ["weights", "model.onnx.data"]]) {
    const path = `${process.env.PIANO_ARIA_MODEL_DIR ?? ".cache/models/aria/onnx-int4-block64"}/${name}`, hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    files.push({ model: "aria", role, name, revision: "local-fixture", sha256: hash.digest("hex"), bytes: (await stat(path)).size,
      url: `http://127.0.0.1:${models.address().port}/models/local-fixture/${name}` });
  }
  const page = await browser.newPage();
  page.on("console", (message) => process.stderr.write(`${message.text()}\n`));
  await page.goto(`http://127.0.0.1:${site.port}/test/duet-generation.html`);
  await page.waitForFunction(() => typeof window.generateDuetFixture === "function");
  const result = await page.evaluate((assets) => window.generateDuetFixture(assets), files);
  assert.equal(result.provider, "webgpu");
  assert.ok(result.reply.length > 0);
  assert.ok(result.reply.every((note) => note.pitch >= 36 && note.pitch <= 84 && [0, 2, 4, 5, 7, 9, 11].includes(note.pitch % 12)
    && note.duration > 0 && note.velocity > 0));
  assert.deepEqual(result.reply, [...result.reply].sort((a, b) => a.start - b.start));
  console.log(JSON.stringify({ provider: result.provider, notes: result.reply.length, elapsedMs: result.elapsedMs }));
} finally {
  await browser?.close();
  await profile.cleanup();
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
