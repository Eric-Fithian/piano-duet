import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { startTestServer } from "../web/server.mjs";

const models = await startServer();
const site = await startTestServer();
const profile = await mkdtemp(join(tmpdir(), "piano-duet-generation-"));
const browser = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true });
try {
  const files = [];
  for (const [role, name] of [["graph", "model.onnx"], ["weights", "model.onnx.data"]]) {
    const path = `.cache/models/aria/onnx-int4-block64/${name}`, hash = createHash("sha256");
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
  await browser.close();
  await rm(profile, { recursive: true, force: true });
  site.server.kill("SIGTERM");
  await new Promise((resolve) => models.close(resolve));
}
