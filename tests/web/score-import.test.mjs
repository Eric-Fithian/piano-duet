import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startTestServer } from "./server.mjs";

let server, port;
before(async () => { ({ server, port } = await startTestServer()); }, { timeout: 45000 });
after(() => server.kill("SIGTERM"));
for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} imports safe MusicXML and rejects hostile MXL`, { timeout: 30000 }, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/test/score-import.html`);
      await page.waitForFunction(() => typeof window.inspectScoreImport === "function");
      const result = await page.evaluate(() => window.inspectScoreImport());
      assert.deepEqual(result.normal, result.archive);
      assert.equal(result.entityError, "MusicXML entity declarations are not supported");
      assert.equal(result.subsetError, "MusicXML internal DTD subsets are not supported");
      assert.equal(result.countError, "The MXL archive has too many entries");
      assert.equal(result.sizeError, "Import a score file under 8 MB");
    } finally { await browser.close(); }
  });
}
