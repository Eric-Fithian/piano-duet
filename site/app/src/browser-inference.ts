import type { DownloadProgress, InferenceBackend, InferenceSession, ModelId, ModelInputs, ModelOutputs } from "./inference";
import type { ModelFile } from "./model-store";

export type ModelRole = "graph" | "weights" | "convolution" | "recurrent" | "features" | "attributes";
export type ModelAsset = ModelFile & { role: ModelRole };
export type ModelCatalog = Partial<Record<ModelId, ModelAsset[]>>;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class BrowserInference implements InferenceBackend {
  constructor(private catalog: ModelCatalog, private preference: "auto" | "wasm" = "auto") {}

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
      throw error;
    }
  }
}

class BrowserSession<K extends ModelId> implements InferenceSession<K> {
  private worker = new Worker(new URL("./inference-worker.ts", import.meta.url), { type: "module" });
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private runtime?: "webgpu" | "wasm";

  get provider(): "webgpu" | "wasm" {
    if (!this.runtime) throw new Error("The inference session is not initialized");
    return this.runtime;
  }

  constructor(readonly model: K, onProgress: (progress: DownloadProgress) => void) {
    this.worker.onmessage = ({ data }: MessageEvent<{ id?: number; progress?: DownloadProgress; value?: unknown; error?: string; errorName?: string }>) => {
      if (data.progress) { onProgress(data.progress); return; }
      if (data.id === undefined) throw new Error("Inference worker sent a response without an ID");
      const pending = this.pending.get(data.id);
      if (!pending) throw new Error(`Unexpected inference response ${data.id}`);
      this.pending.delete(data.id);
      if (data.error) pending.reject(data.errorName === "AbortError" ? new DOMException(data.error, "AbortError") : new Error(data.error));
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
