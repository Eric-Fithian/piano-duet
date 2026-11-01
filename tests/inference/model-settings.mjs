import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { startTestServer } from "../web/server.mjs";

const browserName = process.argv[2];
if (!["chromium", "webkit"].includes(browserName)) throw new Error("Choose chromium or webkit");
const suppliedProfile = process.env.PIANO_MODEL_TEST_PROFILE;
const profile = suppliedProfile ?? await mkdtemp(join(tmpdir(), "piano-model-settings-"));
const suppliedUrl = process.env.PIANO_MODEL_TEST_URL;
const localServer = suppliedUrl ? undefined : await startTestServer();
const url = new URL(suppliedUrl ?? `http://127.0.0.1:${localServer.port}/`);
if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("The model test needs a loopback server");
const browser = await (browserName === "chromium" ? chromium : webkit).launchPersistentContext(profile,
  { headless: true, viewport: { width: 360, height: 800 }, args: browserName === "chromium" ? ["--enable-unsafe-webgpu", "--use-angle=metal"] : [] });
try {
  const page = await browser.newPage();
  await page.goto(url.href);
  await page.waitForFunction(() => document.querySelector("#accountSync")?.textContent.trim().length > 0, null, { timeout: 60000 });
  if (browserName === "chromium") {
    const adapter = await page.evaluate(async () => {
      const gpu = navigator.gpu;
      const info = (await gpu?.requestAdapter())?.info;
      return { vendor: info?.vendor, architecture: info?.architecture };
    });
    assert.equal(adapter.vendor, "apple", `Expected hardware WebGPU, got ${JSON.stringify(adapter)}`);
  }
  await page.locator("#openSettings").click();
  await page.locator("#modelSettings > summary").click();
  await page.locator(".model-actions-disclosure > summary").click();
  await page.getByRole("button", { name: "Test all" }).click();
  await page.waitForFunction(() => !document.querySelector(".model-confirm").hidden
    || !document.querySelector("[data-action=cancel-all]").hidden, null, { timeout: 120000 });
  const confirm = page.getByRole("button", { name: "Download and test", exact: true });
  if (await confirm.isVisible()) await confirm.click();
  const heartbeat = setInterval(() => void page.locator(".model-entry").evaluateAll((rows) => rows.map((row) =>
    `${row.querySelector(".model-name")?.textContent}: ${row.querySelector(".model-status")?.textContent} ${row.querySelector("progress")?.value ?? ""}/${row.querySelector("progress")?.max ?? ""} ${row.querySelector(".model-result")?.textContent ?? ""}`).join(" | "))
    .then((line) => console.log(new Date().toISOString().slice(11, 19), line), () => {}), 30000);
  await page.waitForFunction(() => {
    const text = document.querySelector(".model-message")?.textContent ?? "";
    return text === "All tests passed." || text.includes(" tests failed.");
  }, null, { timeout: 2400000 }).finally(() => clearInterval(heartbeat));
  const results = await page.locator(".model-entry").evaluateAll((rows) => rows.map((row) => ({
    name: row.querySelector(".model-name")?.textContent, status: row.querySelector(".model-status")?.textContent,
    result: row.querySelector(".model-result")?.textContent,
  })));
  assert.equal(results.length, 5);
  for (const result of results) {
    assert.equal(result.status, "Downloaded", `${result.name}: ${result.result}`);
    assert.ok(result.result?.startsWith("Passed"), `${result.name}: ${result.result}`);
  }
  console.log(JSON.stringify({ browser: browserName, results }, null, 2));
} finally {
  await browser.close();
  localServer?.server.kill("SIGTERM");
  if (!suppliedProfile) await rm(profile, { recursive: true, force: true });
}
