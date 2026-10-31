import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startTestServer } from "./server.mjs";

let server, port;
before(async () => { ({ server, port } = await startTestServer()); }, { timeout: 45000 });
after(() => server.kill("SIGTERM"));

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} manages and tests cached model files`, { timeout: 45000 }, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    try {
      let downloads = 0;
      await context.route("**/fixture/fixture-revision/fixture.bin", async (route) => {
        downloads++;
        await route.fulfill({ body: "fixture model weights" });
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/test/model-settings.html`);
      const row = page.locator(".model-entry");
      await row.locator(".model-status").getByText("Not downloaded", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Test all" }).click();
      await page.getByText("Test all will first download up to 21 B for Fixture.").waitFor();
      assert.equal(downloads, 0);
      await page.locator(".model-confirm").getByRole("button", { name: "Cancel" }).click();
      await row.locator("summary").click();
      await row.getByRole("button", { name: "Download", exact: true }).click();
      await row.locator(".model-status").getByText("Downloaded", { exact: true }).waitFor();
      assert.equal(downloads, 1);
      await page.evaluate(async () => { window.releaseFixtureLock = await window.acquireFixtureLock(); });
      await row.getByRole("button", { name: "Delete", exact: true }).click();
      await row.locator(".model-result").getByText("This model is in use", { exact: false }).waitFor();
      await page.evaluate(() => window.releaseFixtureLock());
      await row.getByRole("button", { name: "Delete", exact: true }).click();
      await row.locator(".model-status").getByText("Not downloaded", { exact: true }).waitFor();
      await row.getByRole("button", { name: "Download", exact: true }).click();
      await row.locator(".model-status").getByText("Downloaded", { exact: true }).waitFor();
      assert.equal(downloads, 2);
      await row.getByRole("button", { name: "Re-download" }).click();
      await row.locator("[data-action=cancel]").waitFor({ state: "hidden" });
      await row.locator(".model-status").getByText("Downloaded", { exact: true }).waitFor();
      assert.equal(downloads, 3);
      await row.getByRole("button", { name: "Test", exact: true }).click();
      await row.locator(".model-result").getByText("Passed · fixture").waitFor();
      await page.evaluate(() => window.failFixtureTest());
      await row.getByRole("button", { name: "Test", exact: true }).click();
      await row.locator(".model-result").getByText("Blob loading failed", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Copy diagnostics" }).click();
      await page.getByText("Diagnostics copied.").waitFor();
      const diagnostics = JSON.parse(await page.evaluate(() => window.copiedFixtureDiagnostics()));
      assert.equal(diagnostics.models[0].test.passed, false);
      assert.ok(diagnostics.models[0].test.text.includes("Blob loading failed"));
    } finally { await context.close(); await browser.close(); }
  });
}
