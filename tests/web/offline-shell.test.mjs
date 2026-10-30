import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";

let server;
let port;
before(async () => {
  const probe = createServer();
  await new Promise((resolveReady) => probe.listen(0, "127.0.0.1", resolveReady));
  port = probe.address().port;
  await new Promise((resolveClosed) => probe.close(resolveClosed));
  server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--config", "vite.config.ts", "--port", String(port), "--strictPort"],
    { cwd: resolve("site"), stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolveReady, reject) => {
    server.stdout.on("data", (chunk) => { if (chunk.toString().includes("Local:")) resolveReady(); });
    server.on("exit", (code) => reject(new Error(`Vite preview exited before startup: ${code}`)));
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  });
});
after(() => server.kill("SIGTERM"));

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} reloads the built app offline without clearing model storage`, { timeout: 60000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "piano-duet-offline-"));
    const context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = await context.newPage();
      const origin = `http://127.0.0.1:${port}`;
      const response = await page.goto(`${origin}/`);
      assert.equal(response.status(), 200);
      await page.waitForFunction(() => !document.querySelector("#storage-status").textContent.includes("Preparing"), null, { timeout: 10000 });
      assert.equal(await page.locator("#storage-status").textContent(), "Your progress stays on this device",
        await page.locator("#storage-detail").textContent());
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
        await (await caches.open("piano-duet-models")).put("/saved-model", new Response("model"));
      });
      const docs = await context.request.get(`${origin}/docs/`);
      assert.equal(docs.status(), 200);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => !document.querySelector("#storage-status").textContent.includes("Preparing"), null, { timeout: 10000 });
      assert.equal(await page.locator("#storage-status").textContent(), "Your progress stays on this device",
        await page.locator("#storage-detail").textContent());
      assert.equal(await page.evaluate(async () => (await (await caches.open("piano-duet-models")).match("/saved-model")).text()), "model");
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
