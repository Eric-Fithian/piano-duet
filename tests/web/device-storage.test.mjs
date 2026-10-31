import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startTestServer } from "./server.mjs";

let server;
let port;
before(async () => {
  ({ server, port } = await startTestServer());
}, { timeout: 45000 });
after(() => server.kill("SIGTERM"));

for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${name} persists and merges an append-only SQLite event log`, { timeout: 45000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "piano-duet-profile-"));
    const context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/test/event-log.html`);
      await page.waitForFunction(() => typeof window.createEventLog === "function");
      const initial = await page.evaluate(async () => {
        window.log = window.createEventLog();
        const { deviceId } = await window.log.open();
        let notifications = 0;
        window.log.addEventListener("append", () => { notifications++; });
        const first = await window.log.append("setting", { volume: 0.5 });
        const remote = { id: "remote-attempt", deviceId: "other-device", clock: 8,
          createdAt: "2026-01-01T00:00:00.000Z", kind: "attempt", payload: { score: 95 } };
        const added = await window.log.merge([remote]);
        const repeated = await window.log.merge([remote]);
        const next = await window.log.append("song", { title: "Study" });
        let conflict;
        try {
          await window.log.merge([{ ...remote, id: "must-rollback", clock: 9 },
            { ...remote, payload: { score: 0 } }]);
        } catch (error) { conflict = error.message; }
        return { deviceId, first, added, repeated, next, conflict, notifications, events: await window.log.list() };
      });
      assert.equal(initial.first.deviceId, initial.deviceId);
      assert.equal(initial.first.clock, 1);
      assert.equal(initial.added, 1);
      assert.equal(initial.repeated, 0);
      assert.equal(initial.notifications, 3);
      assert.equal(initial.next.clock, 9);
      assert.ok(initial.conflict.includes("Conflicting event"));
      assert.deepEqual(initial.events.map((event) => event.id), [initial.first.id, "remote-attempt", initial.next.id]);
      await page.evaluate(() => window.log.close());
      const failure = await page.evaluate(() => new Promise((resolve, reject) => {
        const worker = new Worker("/test/sahpool-failure.mjs", { type: "module" });
        worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
        worker.onerror = (error) => { worker.terminate(); reject(new Error(error.message)); };
      }));
      assert.equal(failure.message, "Injected access failure");
      await page.reload();
      await page.waitForFunction(() => typeof window.createEventLog === "function");
      const restored = await page.evaluate(async () => {
        const log = window.createEventLog();
        const identity = await log.open();
        const events = await log.list();
        await log.close();
        return { identity, events };
      });
      assert.equal(restored.identity.deviceId, initial.deviceId);
      assert.deepEqual(restored.events, initial.events);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

  test(`${name} verifies, caches and re-downloads versioned models`, { timeout: 45000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "piano-duet-profile-"));
    const context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const bytes = Buffer.from("a small model fixture");
      const digest = createHash("sha256").update(bytes).digest("hex");
      let downloads = 0;
      await context.route("**/model/revision-a/model.bin", async (route) => {
        downloads++;
        await route.fulfill({ body: bytes, headers: { "Content-Length": String(bytes.length), "Content-Type": "application/octet-stream" } });
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/test/model-store.html`);
      await page.waitForFunction(() => typeof window.createModelStore === "function");
      const descriptor = { model: "aria", name: "model.bin", revision: "revision-a",
        url: `http://127.0.0.1:${port}/model/revision-a/model.bin`, sha256: digest, bytes: bytes.length };
      assert.equal(await page.evaluate(async (file) => {
        window.store = window.createModelStore();
        return window.store.status([file]);
      }, descriptor), "not downloaded");
      const first = await page.evaluate(async (file) => {
        const progress = [];
        const response = await window.store.get(file, (value) => progress.push(value));
        return { text: await response.text(), progress };
      }, descriptor);
      assert.equal(first.text, bytes.toString());
      assert.equal(first.progress.at(-1).received, bytes.length);
      assert.equal(downloads, 1);
      assert.equal(await page.evaluate((file) => window.store.status([file]), descriptor), "downloaded");
      assert.equal(await page.evaluate((file) => window.store.status([file, { ...file, sha256: "0".repeat(64) }]), descriptor), "partially downloaded");
      await page.evaluate((file) => window.store.delete([file]), descriptor);
      assert.equal(await page.evaluate((file) => window.store.status([file]), descriptor), "not downloaded");
      await page.evaluate((file) => window.store.get(file, () => {}), descriptor);
      assert.equal(downloads, 2);
      await context.setOffline(true);
      assert.equal(await page.evaluate(async (file) => (await window.store.get(file, () => {})).text(), descriptor), bytes.toString());
      await context.setOffline(false);
      assert.equal(downloads, 2);
      await page.evaluate(async (file) => {
        const key = new URL(`/.piano-models/${file.model}/${file.revision}/${file.sha256}`, location.origin);
        await (await caches.open("piano-duet-models")).put(key, new Response("x".repeat(file.bytes)));
      }, descriptor);
      assert.equal(await page.evaluate(async (file) => (await window.store.get(file, () => {})).text(), descriptor), "x".repeat(bytes.length));
      await page.evaluate(async (file) => {
        const marker = new URL(`/.piano-models/verified/${encodeURIComponent(file.url)}/${file.sha256}/${file.bytes}`, location.origin);
        await (await caches.open("piano-duet-models")).delete(marker);
      }, descriptor);
      const failure = await page.evaluate(async (file) => {
        try { await window.store.get(file, () => {}); return null; }
        catch (error) { return error.message; }
      }, descriptor);
      assert.ok(failure.includes("integrity check"));
      assert.equal(await page.evaluate(async (file) => (await window.store.get(file, () => {})).text(), descriptor), bytes.toString());
      assert.equal(downloads, 3);
      await page.evaluate(async (file) => {
        const key = new URL(`/.piano-models/${file.model}/${file.revision}/${file.sha256}`, location.origin);
        await (await caches.open("piano-duet-models")).put(key, new Response("short"));
      }, descriptor);
      assert.equal(await page.evaluate((file) => window.store.status([file]), descriptor), "partially downloaded");
      const truncated = await page.evaluate(async (file) => {
        try { await window.store.get(file, () => {}); return null; }
        catch (error) { return error.message; }
      }, descriptor);
      assert.ok(truncated.includes("integrity check"));
      assert.equal(await page.evaluate(async (file) => (await window.store.get(file, () => {})).text(), descriptor), bytes.toString());
      assert.equal(downloads, 4);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

  test(`${name} reports unavailable models and decodes supported live onsets`, { timeout: 45000 }, async () => {
    const profile = await mkdtemp(join(tmpdir(), "piano-duet-profile-"));
    const context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/test/inference.html`);
      await page.waitForFunction(() => typeof window.createBrowserInference === "function");
      const result = await page.evaluate(async () => {
        let missing;
        try { await window.createBrowserInference({}).createSession("aria", () => {}); }
        catch (error) { missing = error.message; }
        const frames = 201;
        const onset = new Float32Array(frames * 88);
        const frame = new Float32Array(frames * 88);
        const velocity = new Float32Array(frames * 88);
        for (const [offset, value] of [[-2, 0.1], [-1, 0.4], [0, 0.95], [1, 0.5], [2, 0.2]]) onset[(50 + offset) * 88 + 39] = value;
        for (let index = 50; index < 56; index++) frame[index * 88 + 39] = 0.6;
        velocity[50 * 88 + 39] = 0.5;
        onset[75 * 88 + 40] = 0.95;
        return { missing, notes: window.decodeLiveOnsets(onset, frame, velocity, frames, 0.8) };
      });
      assert.ok(result.missing.includes("not available"));
      assert.deepEqual(result.notes, [{ pitch: 60, start: 0.5009, velocity: 64, confidence: 0.95 }]);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
