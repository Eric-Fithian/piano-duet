import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ModelStore } from "../../site/app/src/model-store.ts";

test("model status and integrity follow stored bytes and verified downloads", async () => {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalFetch = globalThis.fetch;
  const records = new Map();
  const cache = {
    async match(key) { return records.get(key.url)?.clone(); },
    async put(key, response) { records.set(key.url, new Response(await response.arrayBuffer(), { headers: response.headers })); },
    async delete(key) { return records.delete(key.url); },
  };
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => cache } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://localhost" } });
  const data = "verified model", digest = createHash("sha256").update(data).digest("hex");
  const file = { model: "aria", name: "model.bin", revision: "revision", url: "http://localhost/revision/model.bin", bytes: data.length, sha256: digest };
  const another = { ...file, name: "other.bin", sha256: "0".repeat(64) };
  try {
    const store = new ModelStore();
    assert.equal(await store.status([file, another]), "not downloaded");
    globalThis.fetch = async () => new Response("x".repeat(data.length));
    await assert.rejects(store.get(file, () => {}), { message: "Downloaded model.bin failed its integrity check" });
    assert.equal(await store.status([file]), "not downloaded");
    globalThis.fetch = async () => new Response(data);
    const progress = [];
    assert.equal(await (await store.get(file, (value) => progress.push(value.received))).text(), data);
    assert.equal(progress.at(-1), data.length);
    assert.equal(await store.status([file]), "downloaded");
    assert.equal(await store.status([file, another]), "partially downloaded");
    await store.verifyStored(file, () => {});
    const key = new URL(`/.piano-models/${file.model}/${file.revision}/${file.sha256}`, location.origin);
    records.set(key.href, new Response("x".repeat(data.length)));
    assert.equal(await store.status([file]), "downloaded");
    await assert.rejects(store.verifyStored(file, () => {}), { message: "Cached model.bin failed its integrity check. Re-download it to try again." });
    assert.equal(await store.status([file]), "partially downloaded");
    await store.delete([file]);
    assert.equal(await store.status([file]), "not downloaded");
    let started;
    const fetching = new Promise((resolve) => { started = resolve; });
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      started();
    });
    const controller = new AbortController();
    const pending = store.get(file, () => {}, controller.signal);
    await fetching;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(await store.status([file]), "not downloaded");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches); else Reflect.deleteProperty(globalThis, "caches");
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
  }
});

test("status checks markers and headers without reading cached bodies", async () => {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  let length = null, filePresent = true, markerPresent = true;
  const failBodyRead = () => { throw new Error("Status read a cached body"); };
  const response = { headers: { get: () => length }, blob: failBodyRead, arrayBuffer: failBodyRead, text: failBodyRead,
    get body() { return failBodyRead(); } };
  const cache = { async match(key) { return key.url.includes("/.piano-models/verified/")
    ? markerPresent ? response : undefined : filePresent ? response : undefined; } };
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => cache } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://localhost" } });
  const file = { model: "aria", name: "model.bin", revision: "revision", url: "http://localhost/revision/model.bin",
    bytes: 14, sha256: "0".repeat(64) };
  try {
    const store = new ModelStore();
    assert.equal(await store.status([file]), "downloaded");
    length = "14";
    assert.equal(await store.status([file]), "downloaded");
    length = "13";
    assert.equal(await store.status([file]), "partially downloaded");
    length = "invalid";
    assert.equal(await store.status([file]), "partially downloaded");
    length = null; markerPresent = false;
    assert.equal(await store.status([file]), "partially downloaded");
    filePresent = false;
    assert.equal(await store.status([file]), "not downloaded");
  } finally {
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches); else Reflect.deleteProperty(globalThis, "caches");
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
  }
});
