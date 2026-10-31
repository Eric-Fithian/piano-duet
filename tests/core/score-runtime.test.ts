import assert from "node:assert/strict";
import test from "node:test";
import * as ort from "onnxruntime-web/webgpu";
import { initializeWithWebGPUFallback } from "../../site/app/src/inference.ts";
import { ScoreRuntime } from "../../site/app/src/score-runtime.ts";
import { BrowserRecordingImporter } from "../../site/app/src/browser-recording-import.ts";

test("score initialization releases partial GPU sessions before an observable CPU retry", async () => {
  const originalInfo = console.info;
  const released: string[] = [], attempts: string[] = [], messages: string[] = [];
  const graphs = { encoder: "encoder", first: "first", context: "context", step: "step" };
  let failCPU = false, failRelease = false;
  const create = async (graph: ArrayBuffer | string, options: ort.InferenceSession.SessionOptions): Promise<ort.InferenceSession> => {
    const provider = options.executionProviders?.[0]; attempts.push(`${provider}:${graph}`);
    if (provider === "webgpu" && graph === "context") throw new Error("GPU context creation failed");
    if (provider === "wasm" && failCPU) throw new Error("CPU creation failed");
    return { release: async () => { released.push(`${provider}:${graph}`); if (failRelease) throw new Error("Release failed"); } } as ort.InferenceSession;
  };
  console.info = (...parts: unknown[]) => { messages.push(parts.join(" ")); };
  try {
    const result = await initializeWithWebGPUFallback("midi-to-score", "webgpu", (provider) => ScoreRuntime.open(graphs, provider, create));
    assert.equal(result.backend.provider, "wasm");
    assert.equal(result.backend.fallback?.message, "GPU context creation failed");
    assert.ok(result.backend.fallback?.stack?.includes("GPU context creation failed"));
    assert.ok(messages[0].includes("GPU context creation failed"));
    assert.deepEqual(released, ["webgpu:encoder", "webgpu:first"]);
    assert.deepEqual(attempts, ["webgpu:encoder", "webgpu:first", "webgpu:context", "wasm:encoder", "wasm:first", "wasm:context", "wasm:step"]);
    await result.value.close();

    failCPU = true;
    await assert.rejects(initializeWithWebGPUFallback("midi-to-score", "webgpu", (provider) => ScoreRuntime.open(graphs, provider, create)),
      (error: unknown) => error instanceof AggregateError && error.message.includes("GPU context creation failed") && error.message.includes("CPU creation failed")
        && error.errors.length === 2);

    failRelease = true;
    const count = attempts.length;
    await assert.rejects(initializeWithWebGPUFallback("midi-to-score", "webgpu", (provider) => ScoreRuntime.open(graphs, provider, create)),
      (error: unknown) => error instanceof AggregateError && error.message.includes("cleanup failed"));
    assert.ok(attempts.slice(count).every((attempt) => attempt.startsWith("webgpu:")));
  } finally {
    console.info = originalInfo;
  }
});

test("recording import reports its score backend and preserves both initialization errors", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker"), reports: unknown[] = [], stages: string[] = [];
  let shouldFail = false;
  class FakeWorker {
    onmessage?: (event: { data: Record<string, unknown> }) => void;
    onerror?: (event: { message: string }) => void;
    postMessage(message: { id: number }) {
      queueMicrotask(() => {
        this.onmessage?.({ data: { id: message.id, stage: "Ready · midi-to-score: CPU (WebGPU failed: GPU failed)" } });
        this.onmessage?.({ data: shouldFail
          ? { id: message.id, error: "GPU failed; CPU failed", errorName: "AggregateError", errorCauses: [
            { name: "WebGPUInitializationError", message: "GPU failed", stack: "GPU stack" },
            { name: "Error", message: "CPU failed", stack: "CPU stack" },
          ] }
          : { id: message.id, value: { provider: "wasm", fallback: { provider: "webgpu", message: "GPU failed", stack: "GPU stack" } } } });
      });
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker });
  try {
    const importer = new BrowserRecordingImporter([], [], () => {}, (stage) => stages.push(stage), (record) => reports.push(record));
    await importer.prepare();
    assert.deepEqual(reports, [{ provider: "wasm", fallback: { provider: "webgpu", message: "GPU failed", stack: "GPU stack" } }]);
    assert.equal(stages[0], "Ready · midi-to-score: CPU (WebGPU failed: GPU failed)");
    shouldFail = true;
    await assert.rejects(new BrowserRecordingImporter([], [], () => {}, () => {}).prepare(), (error: unknown) =>
      error instanceof AggregateError && error.errors.map((cause: Error) => cause.message).join(", ") === "GPU failed, CPU failed"
        && error.errors[0].stack === "GPU stack" && error.errors[1].stack === "CPU stack");
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
