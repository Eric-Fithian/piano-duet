import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startTestServer } from "./server.mjs";

let server, port;
before(async () => { ({ server, port } = await startTestServer()); }, { timeout: 45000 });
after(() => server.kill("SIGTERM"));

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} rebuilds Reading progress from stored attempts and exclusions`, { timeout: 45000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "piano-duet-reading-"));
    const browser = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/test/reading-state.html`);
      await page.waitForFunction(() => typeof window.openReadingLog === "function");
      const result = await page.evaluate(async () => {
        await window.openReadingLog();
        const attempt = await window.saveReading();
        const saved = await window.readingProgress();
        await window.excludeReading(attempt.id, true);
        const excluded = await window.readingProgress();
        await window.excludeReading(attempt.id, false);
        const restored = await window.readingProgress();
        await window.closeReadingLog();
        return { saved, excluded, restored };
      });
      assert.equal(result.saved.history[0].id, 'reading-test-attempt');
      assert.equal(result.saved.rounds, 1);
      assert.equal(result.saved.notes, 4);
      assert.equal(result.saved.xp.xp, 80);
      assert.equal(result.excluded.rounds, 0);
      assert.equal(result.excluded.xp.xp, 0);
      assert.deepEqual(result.restored, result.saved);
      await page.reload();
      await page.waitForFunction(() => typeof window.openReadingLog === "function");
      const reloaded = await page.evaluate(async () => {
        await window.openReadingLog();
        const progress = await window.readingProgress();
        await window.closeReadingLog();
        return progress;
      });
      assert.deepEqual(reloaded, result.saved);
    } finally {
      await browser.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
