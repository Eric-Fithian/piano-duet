import assert from "node:assert/strict";
import test from "node:test";
import { BrowserInference } from "../../site/app/src/browser-inference.ts";
import { MODEL_CATALOG } from "../../site/app/src/model-catalog.ts";
import { describeInferenceBackend } from "../../site/app/src/inference.ts";

test("browser inference retries only failed WebGPU initialization and retains the cause", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker"), originalInfo = console.info;
  const messages: string[] = [], workers: FakeWorker[] = [];
  let outcomes: ("gpu-failure" | "wasm-failure" | "other-failure" | "success")[] = [];
  class FakeWorker {
    onmessage?: (event: { data: Record<string, unknown> }) => void;
    onerror?: (event: { message: string }) => void;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(message: { id: number; action: string; preference?: string }) {
      if (message.action === "cancel") return;
      const outcome = message.action === "open" ? outcomes.shift() : "other-failure";
      if (!outcome) throw new Error("No fake worker outcome was configured");
      queueMicrotask(() => this.onmessage?.({ data: outcome === "gpu-failure"
        ? { id: message.id, error: "GPU session failed", errorName: "WebGPUInitializationError", errorStack: "GPU failure stack" }
        : outcome === "wasm-failure" ? { id: message.id, error: "WASM session failed", errorName: "Error" }
          : outcome === "other-failure" ? { id: message.id, error: "Inference failed", errorName: "Error" }
            : { id: message.id, value: { provider: message.preference === "wasm" ? "wasm" : "webgpu" } } }));
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker });
  console.info = (...parts: unknown[]) => { messages.push(parts.join(" ")); };
  try {
    outcomes = ["gpu-failure", "success"];
    const session = await new BrowserInference(MODEL_CATALOG).createSession("aria", () => {});
    assert.equal(session.provider, "wasm");
    assert.deepEqual(session.fallback, { provider: "webgpu", message: "GPU session failed", stack: "GPU failure stack" });
    assert.equal(describeInferenceBackend(session), "aria: CPU (WebGPU failed: GPU session failed)");
    assert.equal(workers.length, 2);
    assert.ok(workers[0].terminated);
    assert.ok(messages[0].includes("GPU session failed") && messages[0].includes("GPU failure stack"));
    await assert.rejects(session.run({ tokens: [1], reset: true }), { message: "Inference failed" });
    assert.equal(workers.length, 2);

    outcomes = ["gpu-failure", "wasm-failure"];
    await assert.rejects(new BrowserInference(MODEL_CATALOG).createSession("aria", () => {}), (error: unknown) =>
      error instanceof AggregateError && error.message.includes("WebGPU: GPU session failed; CPU: WASM session failed")
        && error.errors.map((cause: Error) => cause.message).join(", ") === "GPU session failed, WASM session failed");
    assert.ok(workers[2].terminated && workers[3].terminated);

    outcomes = ["other-failure"];
    await assert.rejects(new BrowserInference(MODEL_CATALOG).createSession("aria", () => {}), { message: "Inference failed" });
    assert.equal(workers.length, 5);
  } finally {
    console.info = originalInfo;
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
