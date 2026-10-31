import assert from "node:assert/strict";
import test from "node:test";
import { NativeInference } from "../../site/app/src/native-inference.ts";
import type { NativeInferenceTransport } from "../../site/app/src/native-inference.ts";

test("native inference uses the shared model interface and little-endian float messages", async () => {
  const requests: Record<string, unknown>[] = [], progress: unknown[] = [];
  const transport: NativeInferenceTransport = { async request(message, _signal, onProgress) {
    requests.push(message);
    if (message.action === "open") {
      onProgress?.({ model: "aria", file: "weights", received: 12, total: 24 });
      return { session: "native-session" };
    }
    if (message.action === "run") return { logits: { $type: "float32-le", data: "AACAPwAAAMA=" } };
    return {};
  } };
  const session = await new NativeInference(transport).createSession("aria", (value) => progress.push(value));
  assert.equal(session.provider, "native");
  assert.deepEqual(await session.run({ tokens: [6, 0], reset: true }), { logits: new Float32Array([1, -2]) });
  assert.deepEqual(progress, [{ model: "aria", file: "weights", received: 12, total: 24 }]);
  await session.close();
  await session.close();
  await assert.rejects(session.run({ tokens: [1], reset: false }), { message: "The inference session is closed" });
  assert.deepEqual(requests.map((item) => item.action), ["open", "run", "close"]);
  assert.deepEqual(requests[1], { action: "run", session: "native-session", input: { tokens: [6, 0], reset: true } });

  const audioRequests: Record<string, unknown>[] = [];
  const audioTransport: NativeInferenceTransport = { async request(message) {
    audioRequests.push(message);
    return message.action === "open" ? { session: "audio" } : { notes: [] };
  } };
  const audioSession = await new NativeInference(audioTransport).createSession("live-transcription", () => {});
  const backing = new Float32Array([99, 1, -2, 99]);
  await audioSession.run({ audio: backing.subarray(1, 3), sampleRate: 16000, threshold: 0.8 });
  assert.deepEqual(audioRequests[1].input, { audio: { $type: "float32-le", data: "AACAPwAAAMA=" }, sampleRate: 16000, threshold: 0.8 });
});

test("native sessions reject concurrent work, malformed output and aborted requests", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const transport: NativeInferenceTransport = { async request(message) {
    if (message.action === "open") return { session: "one" };
    if (message.action === "close") return {};
    return new Promise((resolve) => { finish = resolve; });
  } };
  const session = await new NativeInference(transport).createSession("aria", () => {});
  const first = session.run({ tokens: [0], reset: true });
  await assert.rejects(session.run({ tokens: [0], reset: true }), { message: "The inference session is already running" });
  await assert.rejects(session.close(), { message: "The inference session is already running" });
  finish!({ logits: { $type: "float32-le", data: "AA==" } });
  await assert.rejects(first, { message: "Native inference returned truncated float data" });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(session.run({ tokens: [0], reset: true }, abort.signal), { name: "AbortError" });
  await session.close();
});
