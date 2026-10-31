import type { DownloadProgress } from "./inference.ts";
import type { NativeInferenceTransport } from "./native-inference.ts";

export interface WebKitMessageHandler { postMessage(message: Record<string, unknown>): Promise<unknown> }

export class WebKitInferenceTransport implements NativeInferenceTransport {
  private readonly handler: WebKitMessageHandler;
  private readonly events: EventTarget;

  constructor(handler: WebKitMessageHandler, events: EventTarget) { this.handler = handler; this.events = events; }

  async request(message: Record<string, unknown>, signal?: AbortSignal, onProgress?: (progress: DownloadProgress) => void): Promise<unknown> {
    signal?.throwIfAborted();
    if (Object.hasOwn(message, "requestId")) throw new Error("Native inference request IDs are reserved");
    const requestId = crypto.randomUUID();
    let failProgress: (error: Error) => void = () => { throw new Error("Native progress channel is not initialized"); };
    const progressFailure = new Promise<never>((_resolve, reject) => { failProgress = reject; });
    const progress = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isObject(detail) || detail.requestId !== requestId) return;
      if (!isProgress(detail.progress)) { failProgress(new Error("Native inference sent invalid download progress")); return; }
      onProgress?.(detail.progress);
    };
    this.events.addEventListener("piano-inference-progress", progress);
    let abort: (() => void) | undefined;
    try {
      const response = Promise.race([Promise.resolve().then(() => this.handler.postMessage({ ...message, requestId })), progressFailure])
        .catch((error: unknown) => { if (signal?.aborted) throw signal.reason; throw error; });
      if (!signal) return await response;
      const cancellation = new Promise<never>((_resolve, reject) => {
        abort = () => { void Promise.resolve().then(() => this.handler.postMessage({ action: "cancel", target: requestId }))
          .then(() => reject(signal.reason), reject); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      const result = await Promise.race([response, cancellation]);
      signal.throwIfAborted();
      return result;
    } finally {
      if (signal && abort) signal.removeEventListener("abort", abort);
      this.events.removeEventListener("piano-inference-progress", progress);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProgress(value: unknown): value is DownloadProgress {
  return isObject(value) && ["aria", "live-transcription", "phrase-transcription", "recording-transcription", "midi-to-score", "piano-samples"].includes(String(value.model))
    && typeof value.file === "string" && typeof value.received === "number" && Number.isFinite(value.received) && value.received >= 0
    && (value.total === null || typeof value.total === "number" && Number.isFinite(value.total) && value.total >= value.received);
}
