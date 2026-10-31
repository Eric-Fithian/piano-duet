import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { installReadingProbe } from "../inference/reading-latency-preload.mjs";
import { startServer } from "../inference/server.mjs";

test("Safari's fake microphone preload runs before the reference app", async () => {
  const upstream = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Content-Security-Policy", "script-src 'self'");
    response.end('<!doctype html><head><script src="/app.js"></script></head>');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startServer({ referencePort: upstream.address().port, preloadScript: () => "window.fakeInstalled = true;" });
  try {
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const page = await fetch(`${base}/`), html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(html.indexOf("/test/safari-reading-preload.js") >= 0);
    assert.ok(html.indexOf("/test/safari-reading-preload.js") < html.indexOf("/app.js"));
    assert.ok(page.headers.get("content-security-policy").includes("script-src 'self'"));
    const script = await fetch(`${base}/test/safari-reading-preload.js`);
    assert.equal(script.headers.get("content-type"), "text/javascript");
    assert.equal(await script.text(), "window.fakeInstalled = true;");
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Safari's fake microphone survives fresh MediaDevices wrappers", async () => {
  let hardwareCalls = 0, click;
  const prototype = { async getUserMedia() { hardwareCalls++; throw new Error("Hardware microphone was reached"); },
    async enumerateDevices() { throw new Error("Hardware devices were enumerated"); } };
  const navigator = { get mediaDevices() { return Object.create(prototype); } };
  class Track { constructor(id = "synthetic-track") { this.id = id; } get label() { return "audio destination"; } }
  const stream = { getAudioTracks: () => [new Track()] };
  const node = () => ({ connect(destination) { return destination; } });
  class AudioContext {
    sampleRate = 48000;
    state = "running";
    destination = node();
    createMediaStreamDestination() { return { ...node(), stream }; }
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { return node(); }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    async resume() {}
  }
  const document = { addEventListener(name, callback) { if (name === "click") click = callback; }, querySelector() { return null; } };
  class MutationObserver { observe() {} }
  const context = createContext({ navigator, document, MutationObserver, AudioContext, fetch: async () => {}, performance });
  context.window = context;
  runInContext(`(${installReadingProbe.toString()})("python", null, 2)`, context);
  assert.equal(context.__latency.fakeInstalled, true);
  click({ target: { closest: (selector) => selector === "#start" } });
  const captured = await navigator.mediaDevices.getUserMedia({ audio: true });
  assert.equal(captured, stream);
  assert.equal(captured.getAudioTracks()[0].label, "Piano Duet synthetic microphone");
  assert.equal(new Track("hardware-track").label, "audio destination");
  assert.equal(context.__latency.fakeCalls, 1);
  assert.equal(hardwareCalls, 0);
});
