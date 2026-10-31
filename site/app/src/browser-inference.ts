import type { DownloadProgress, InferenceBackend, InferenceSession, ModelFile, ModelId, ModelInputs, ModelOutputs } from "./inference.ts";

export type ModelRole = "graph" | "weights" | "convolution" | "recurrent" | "features" | "attributes"
  | "score-encoder" | "score-first" | "score-context" | "score-step";
export type ModelAsset = ModelFile & { role: ModelRole };
export type ModelCatalog = Partial<Record<ModelId, ModelAsset[]>>;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class BrowserInference implements InferenceBackend {
  private readonly catalog: ModelCatalog;
  private readonly preference: "auto" | "wasm";

  constructor(catalog: ModelCatalog, preference: "auto" | "wasm" = "auto") {
    this.catalog = catalog; this.preference = preference;
  }

  async createSession<K extends ModelId>(model: K, onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal): Promise<InferenceSession<K>> {
    const files = this.catalog[model];
    if (!files?.length) throw new Error(`The ${model} model is not available yet`);
    const session = new BrowserSession(model, onProgress);
    try {
      await session.initialize(files, this.preference, signal);
      return session;
    } catch (error) {
      session.terminate();
      if (this.preference === "auto" && error instanceof Error && error.name === "WebGPUInitializationError" && !signal?.aborted) {
        console.info(`WebGPU could not initialize ${model}; retrying with WASM: ${error.message}\n${error.stack ?? ""}`);
        const fallback = new BrowserSession(model, onProgress, { provider: "webgpu", message: error.message, stack: error.stack });
        try {
          await fallback.initialize(files, "wasm", signal);
          return fallback;
        } catch (fallbackError) {
          fallback.terminate();
          if (signal?.aborted) throw signal.reason;
          const reason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw new AggregateError([error, fallbackError], `Could not initialize ${model}: WebGPU: ${error.message}; CPU: ${reason}`);
        }
      }
      throw error;
    }
  }
}

class BrowserSession<K extends ModelId> implements InferenceSession<K> {
  readonly model: K;
  readonly fallback?: InferenceSession<K>["fallback"];
  private worker = new Worker(new URL("./inference-worker.ts", import.meta.url), { type: "module" });
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private runtime?: "webgpu" | "wasm";

  get provider(): "webgpu" | "wasm" {
    if (!this.runtime) throw new Error("The inference session is not initialized");
    return this.runtime;
  }

  constructor(model: K, onProgress: (progress: DownloadProgress) => void, fallback?: InferenceSession<K>["fallback"]) {
    this.model = model; this.fallback = fallback;
    this.worker.onmessage = ({ data }: MessageEvent<{ id?: number; progress?: DownloadProgress; value?: unknown; error?: string; errorName?: string; errorStack?: string }>) => {
      if (data.progress) { onProgress(data.progress); return; }
      if (data.id === undefined) throw new Error("Inference worker sent a response without an ID");
      const pending = this.pending.get(data.id);
      if (!pending) throw new Error(`Unexpected inference response ${data.id}`);
      this.pending.delete(data.id);
      if (data.error) {
        const error = data.errorName === "AbortError" ? new DOMException(data.error, "AbortError")
          : Object.assign(new Error(data.error), { name: data.errorName ?? "Error" });
        if (data.errorStack) error.stack = data.errorStack;
        pending.reject(error);
      }
      else pending.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      const error = new Error(`Inference worker failed: ${event.message}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.terminate();
    };
  }

  async initialize(files: ModelAsset[], preference: "auto" | "wasm", signal?: AbortSignal): Promise<void> {
    const result = await this.send<{ provider: "webgpu" | "wasm" }>("open", { model: this.model, files, preference }, signal);
    this.runtime = result.provider;
  }

  run(input: ModelInputs[K], signal?: AbortSignal): Promise<ModelOutputs[K]> {
    return this.send("run", { input }, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.send("close");
    this.terminate();
  }

  terminate(): void {
    this.closed = true;
    this.worker.terminate();
  }

  private send<T>(action: string, fields: object = {}, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The inference session is closed"));
    if (this.pending.size) return Promise.reject(new Error("The inference session is already running"));
    signal?.throwIfAborted();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => this.worker.postMessage({ action: "cancel", target: id });
      signal?.addEventListener("abort", abort, { once: true });
      const finish = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, {
        resolve: (value) => { finish(); resolve(value as T); },
        reject: (error) => { finish(); if (signal?.aborted) this.terminate(); reject(error); },
      });
      this.worker.postMessage({ id, action, ...fields });
    });
  }
}
