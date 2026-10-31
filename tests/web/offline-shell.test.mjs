import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startTestServer } from "./server.mjs";

let server;
let port;
before(async () => {
  ({ server, port } = await startTestServer(true));
}, { timeout: 45000 });
after(() => server?.kill("SIGTERM"));

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} reloads the built app offline without clearing model storage`, { timeout: 60000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "piano-duet-offline-"));
    const context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      await context.route("https://raw.githubusercontent.com/**", (route) => route.abort());
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.offlineInstallError = null;
        navigator.serviceWorker.addEventListener("message", (event) => {
          if (event.data?.type === "offline-install-error") window.offlineInstallError = event.data.error;
        });
      });
      const origin = `http://127.0.0.1:${port}`;
      const response = await page.goto(`${origin}/`);
      assert.equal(response.status(), 200);
      await page.waitForFunction(() => window.VexFlow && document.querySelector(".mode-switch"), null, { timeout: 10000 });
      console.log(`${name} storage estimate: ${JSON.stringify(await page.evaluate(() => navigator.storage.estimate()))}`);
      await page.waitForFunction(() => navigator.serviceWorker.controller || window.offlineInstallError, null, { timeout: 15000 });
      const installError = await page.evaluate(() => window.offlineInstallError);
      if (installError) {
        await page.waitForFunction(() => document.querySelector("#error")?.textContent.includes(window.offlineInstallError));
        assert.equal(await page.locator("#error").isVisible(), true);
      }
      assert.equal(installError, null, `${name} service worker installation failed: ${installError}`);
      await page.evaluate(async () => {
        await (await caches.open("piano-duet-models")).put("/saved-model", new Response("model"));
      });
      const docs = await context.request.get(`${origin}/docs/`);
      assert.equal(docs.status(), 200);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => window.VexFlow && document.querySelector(".mode-switch"), null, { timeout: 10000 });
      assert.equal(await page.evaluate(async () => (await (await caches.open("piano-duet-models")).match("/saved-model")).text()), "model");
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
