import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startTestServer } from "./server.mjs";

let server, port;
before(async () => { ({ server, port } = await startTestServer()); }, { timeout: 45000 });
after(() => server.kill("SIGTERM"));
for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} imports a YouTube response into a locally saved song`, { timeout: 30000 }, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("**/api/youtube-audio", async (route) => {
        const request = route.request();
        assert.equal(request.headers()["x-duet-client"], "1");
        assert.deepEqual(request.postDataJSON(), { url: "https://youtu.be/abcdefghijk" });
        const metadata = Buffer.from(JSON.stringify({ title: "Piano étude", channel: "A pianist", url: "https://www.youtube.com/watch?v=abcdefghijk" })).toString("base64");
        await route.fulfill({ status: 200, headers: { "x-duet-video": metadata, "content-type": "application/octet-stream" }, body: Buffer.from([1, 2, 3, 4]) });
      });
      await page.goto(`http://127.0.0.1:${port}/test/youtube-import.html`);
      await page.waitForFunction(() => window.youtubeTestReady);
      await page.click("#importYoutubeLink");
      await page.fill("#youtubeUrl", "https://youtu.be/abcdefghijk");
      await page.check("#youtubeRights");
      await page.click("#youtubeGo");
      await page.waitForFunction(() => window.savedEvents?.length === 1);
      const result = await page.evaluate(() => ({ audio: window.receivedAudio, event: window.savedEvents[0] }));
      assert.deepEqual(result.audio, [1, 2, 3, 4]);
      assert.equal(result.event.payload.song.title, "Piano étude");
      assert.equal(result.event.payload.song.artist, "A pianist");
      assert.equal(result.event.payload.song.source, "YouTube");
      assert.equal(result.event.payload.song.transcribed, true);
      assert.ok(result.event.payload.song.notes.length > 0);
      assert.equal(await page.locator("#youtubeDialog").evaluate((dialog) => dialog.open), false);
    } finally { await browser.close(); }
  });
}

test("a blocked download offers the recording alternatives without saving a song", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/api/youtube-audio", (route) => route.fulfill({ status: 502, contentType: "application/json",
      body: JSON.stringify({ detail: "YouTube blocked this server as a bot." }) }));
    await page.goto(`http://127.0.0.1:${port}/test/youtube-import.html`);
    await page.waitForFunction(() => window.youtubeTestReady);
    await page.click("#importYoutubeLink");
    await page.fill("#youtubeUrl", "https://youtu.be/abcdefghijk");
    await page.check("#youtubeRights");
    await page.click("#youtubeGo");
    await page.waitForSelector("#youtubeError:not([hidden])");
    assert.equal(await page.locator("#youtubeError").textContent(), "YouTube blocked this server as a bot. Try Import audio or Record audio instead.");
    assert.equal(await page.evaluate(() => window.savedEvents?.length ?? 0), 0);
  } finally { await browser.close(); }
});

test("closing the dialog cancels a download without saving", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/youtube-audio", async (route) => {
      await gate;
      await route.fulfill({ status: 502, contentType: "application/json", body: '{"detail":"late"}' });
    });
    await page.goto(`http://127.0.0.1:${port}/test/youtube-import.html`);
    await page.waitForFunction(() => window.youtubeTestReady);
    await page.click("#importYoutubeLink");
    await page.fill("#youtubeUrl", "https://youtu.be/abcdefghijk");
    await page.check("#youtubeRights");
    await page.click("#youtubeGo");
    await page.waitForSelector('[data-close="youtubeDialog"]:text-is("Cancel")');
    await page.click('[data-close="youtubeDialog"]');
    release();
    await page.waitForFunction(() => document.querySelector("#youtubeGo").disabled === false);
    assert.equal(await page.evaluate(() => window.savedEvents?.length ?? 0), 0);
    assert.equal(await page.locator("#youtubeError").isVisible(), false);
  } finally { await browser.close(); }
});
