import assert from "node:assert/strict";
import test from "node:test";
import { NativeInference } from "../../site/app/src/native-inference.ts";
import { NativeRecordingImporter } from "../../site/app/src/native-recording-import.ts";
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

test("native recording import sends decoded audio and notes through the native sessions", async () => {
  const requests: Record<string, unknown>[] = [], stages: string[] = [];
  const notes = [{ pitch: 60, start: 0.5, duration: 1, velocity: 90 }];
  const transport: NativeInferenceTransport = { async request(message) {
    requests.push(message);
    if (message.action === "open") return { session: message.model };
    if (message.session === "recording-transcription") return { notes };
    if (message.session === "midi-to-score") return { musicXml: "<score-partwise/>" };
    throw new Error("Unexpected native request");
  } };
  const importer = new NativeRecordingImporter(new NativeInference(transport), () => {}, (stage) => stages.push(stage),
    async () => ({ audio: new Float32Array([1, -2]), backend: "test" }));
  await importer.prepare();
  assert.deepEqual(await importer.run(new ArrayBuffer(0)), { musicXml: "<score-partwise/>", notes });
  assert.deepEqual(stages, ["Opening the recording", "Finding the notes", "Writing the score"]);
  assert.deepEqual(requests.map((request) => request.action), ["open", "open", "run", "run"]);
  assert.deepEqual(requests[2].input, { audio: { $type: "float32-le", data: "AACAPwAAAMA=" }, sampleRate: 44100 });
  assert.deepEqual(requests[3].input, { notes });
});

test("native recording import closes a partially opened session and can retry", async () => {
  const requests: Record<string, unknown>[] = [];
  let failScore = true;
  const transport: NativeInferenceTransport = { async request(message) {
    requests.push(message);
    if (message.model === "midi-to-score" && failScore) { failScore = false; throw new Error("Score model unavailable"); }
    return message.action === "open" ? { session: message.model } : {};
  } };
  const importer = new NativeRecordingImporter(new NativeInference(transport), () => {}, () => {});
  await assert.rejects(importer.prepare(), { message: "Score model unavailable" });
  assert.deepEqual(requests[2], { action: "close", session: "recording-transcription" });
  await importer.prepare();
  assert.deepEqual(requests.map((request) => request.action), ["open", "open", "close", "open", "open"]);
});
