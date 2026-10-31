import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  test(`${name} hides closed model rows and can scroll to their controls`, { timeout: 45000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "piano-model-layout-"));
    const context = await engine.launchPersistentContext(profile, { headless: true, viewport: { width: 744, height: 1133 }, hasTouch: true });
    try {
      const bytes = Buffer.alloc(1644);
      bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
      bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
      bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
      bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(1600, 40);
      const sample = { pitch: 60, file: "C4.mp3", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
      await context.route("**/src/piano-samples.ts", (route) => route.fulfill({ contentType: "text/javascript",
        body: `export const SAMPLE_REVISION = "layout-fixture"; export const PIANO_SAMPLES = ${JSON.stringify([sample])};` }));
      await context.route("https://raw.githubusercontent.com/**/layout-fixture/samples/piano/C4.mp3", (route) => route.fulfill({ body: bytes,
        headers: { "Content-Type": "audio/wav", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" } }));
      await context.route("**/src/browser-inference.ts", (route) => route.fulfill({ contentType: "text/javascript",
        body: 'export class BrowserInference { async createSession(model) { return {model, provider: "wasm", run: async () => model === "aria" ? {logits: new Float32Array(18000)} : {notes: []}}; } }' }));
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => document.querySelector("#accountSync")?.textContent.trim().length > 0, null, { timeout: 30000 });
      await page.locator("#openSettings").click();
      const models = page.locator("#modelSettings"), dialog = page.locator("#settingsDialog");
      const closedRows = await models.locator(".model-row").evaluateAll((rows) => rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }));
      assert.equal(closedRows.length, 5);
      assert.ok(closedRows.every(({ width, height }) => width === 0 && height === 0), JSON.stringify(closedRows));
      await models.locator(":scope > summary").scrollIntoViewIfNeeded();
      await models.locator(":scope > summary").click();
      const lastRow = models.locator(".model-entry").last();
      await lastRow.locator("summary").scrollIntoViewIfNeeded();
      await lastRow.locator("summary").click();
      const source = lastRow.getByRole("link", { name: "Source at pinned revision" });
      await source.scrollIntoViewIfNeeded();
      assert.equal(await source.isVisible(), true);
      const bounds = await source.boundingBox(), dialogBounds = await dialog.boundingBox();
      assert.ok(bounds && dialogBounds && bounds.y >= dialogBounds.y && bounds.y + bounds.height <= dialogBounds.y + dialogBounds.height);
      assert.ok(await dialog.locator(":scope > .controls").evaluate((element) => element.scrollTop > 0));
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });

  test(`${name} offers a named download and test action for each model`, { timeout: 45000 }, async () => {
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
      const quick = page.locator(".model-test");
      await quick.getByText("Download and test (21 B)").waitFor();
      await quick.click();
      await page.locator(".model-result").getByText("Passed · fixture").waitFor();
      assert.equal(downloads, 1);
      assert.equal(await quick.textContent(), "Test");
      await quick.click();
      await page.locator(".model-result").getByText("Passed · fixture").waitFor();
      assert.equal(downloads, 1);
    } finally { await context.close(); await browser.close(); }
  });

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
      await page.locator(".model-actions-disclosure > summary").click();
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
      await page.evaluate(async () => {
        const key = new URL("/.piano-models/aria/fixture-revision/a21e5c2f98f6b674aeeba3d88362cf618da2d78ae6f9a07ff9cac7f2907e283f", location.origin);
        await (await caches.open("piano-duet-models")).put(key, new Response("x".repeat(21)));
      });
      await row.getByRole("button", { name: "Test", exact: true }).click();
      await row.locator(".model-result").getByText("failed its integrity check", { exact: false }).waitFor();
      await row.locator(".model-status").getByText("Partial", { exact: true }).waitFor();
      await row.getByRole("button", { name: "Re-download" }).click();
      await row.locator(".model-status").getByText("Downloaded", { exact: true }).waitFor();
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
