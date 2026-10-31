import assert from "node:assert/strict";
import test from "node:test";
import { WebKitInferenceTransport } from "../../site/app/src/webkit-inference-transport.ts";

test("WebKit inference routes progress to the matching request", async () => {
  const events = new EventTarget(), messages: Record<string, unknown>[] = [], progress: unknown[] = [];
  const handler = { async postMessage(message: Record<string, unknown>) {
    messages.push(message);
    events.dispatchEvent(new CustomEvent("piano-inference-progress", { detail: { requestId: "other", progress: {} } }));
    events.dispatchEvent(new CustomEvent("piano-inference-progress", { detail: { requestId: message.requestId,
      progress: { model: "aria", file: "weights", received: 1, total: 2 } } }));
    return { session: "one" };
  } };
  const result = await new WebKitInferenceTransport(handler, events).request({ action: "open", model: "aria" }, undefined, (value) => progress.push(value));
  assert.deepEqual(result, { session: "one" });
  assert.equal(typeof messages[0].requestId, "string");
  assert.deepEqual(progress, [{ model: "aria", file: "weights", received: 1, total: 2 }]);
});

test("WebKit inference cancels in-flight native work and rejects malformed progress", async () => {
  const events = new EventTarget(), abort = new AbortController(), messages: Record<string, unknown>[] = [];
  const handler = { async postMessage(message: Record<string, unknown>): Promise<unknown> {
    messages.push(message);
    if (message.action === "cancel") return {};
    abort.abort();
    return new Promise(() => {});
  } };
  const transport = new WebKitInferenceTransport(handler, events);
  await assert.rejects(transport.request({ action: "run", session: "one" }, abort.signal), { name: "AbortError" });
  assert.deepEqual(messages[1], { action: "cancel", target: messages[0].requestId });
  const invalidMessages: Record<string, unknown>[] = [];
  const invalid = new WebKitInferenceTransport({ async postMessage(message) {
    invalidMessages.push(message);
    if (message.action === "cancel") return {};
    events.dispatchEvent(new CustomEvent("piano-inference-progress", { detail: { requestId: message.requestId, progress: { model: "aria" } } }));
    return new Promise(() => {});
  } }, events);
  await assert.rejects(invalid.request({ action: "open", model: "aria" }), { message: "Native inference sent invalid download progress" });
  assert.deepEqual(invalidMessages[1], { action: "cancel", target: invalidMessages[0].requestId });
  let finishCancellation: (() => void) | undefined;
  const completedAfterInvalidProgress = new WebKitInferenceTransport({ async postMessage(message) {
    if (message.action === "cancel") return new Promise<void>((resolve) => { finishCancellation = resolve; });
    events.dispatchEvent(new CustomEvent("piano-inference-progress", { detail: { requestId: message.requestId, progress: {} } }));
    return { session: "unexpected" };
  } }, events);
  const rejected = completedAfterInvalidProgress.request({ action: "open", model: "aria" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(finishCancellation);
  finishCancellation();
  await assert.rejects(rejected, { message: "Native inference sent invalid download progress" });
  const nativeCancelled = new WebKitInferenceTransport({ async postMessage(message) {
    if (message.action === "cancel") return {};
    events.dispatchEvent(new CustomEvent("piano-inference-progress", { detail: { requestId: message.requestId, progress: {} } }));
    throw new Error("Native task cancelled");
  } }, events);
  await assert.rejects(nativeCancelled.request({ action: "open", model: "aria" }), { message: "Native inference sent invalid download progress" });
  const rejectedCancel = new WebKitInferenceTransport({ async postMessage(message) {
    if (message.action === "cancel") throw new Error("Cancellation failed");
    events.dispatchEvent(new CustomEvent("piano-inference-progress", { detail: { requestId: message.requestId, progress: {} } }));
    return new Promise(() => {});
  } }, events);
  await assert.rejects(rejectedCancel.request({ action: "open", model: "aria" }), (error: unknown) =>
    error instanceof AggregateError && error.errors.some((cause: unknown) => cause instanceof Error && cause.message === "Cancellation failed"));
  const race = new AbortController();
  const raced = new WebKitInferenceTransport({ async postMessage(message) {
    if (message.action === "cancel") return {};
    race.abort();
    throw new Error("The native task was cancelled");
  } }, events);
  await assert.rejects(raced.request({ action: "run", session: "one" }, race.signal), { name: "AbortError" });
});
