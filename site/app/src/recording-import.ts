import { decodeAudioFile } from "./audio-decoder";
import type { DownloadProgress, PianoNote } from "./inference";
import type { ModelAsset } from "./browser-inference";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class BrowserRecordingImporter {
  private worker?: Worker;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private opening?: Promise<void>;

  constructor(private recording: ModelAsset[], private score: ModelAsset[], private progress: (value: DownloadProgress) => void,
    private stage: (value: string) => void) {}

  prepare(signal?: AbortSignal): Promise<void> {
    if (!this.opening) {
      this.worker = new Worker(new URL("./recording-import-worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = ({ data }: MessageEvent<{ id: number; value?: unknown; error?: string; errorName?: string;
        progress?: DownloadProgress; stage?: string }>) => {
        if (data.progress) { this.progress(data.progress); return; }
        if (data.stage) { this.stage(data.stage); return; }
        const pending = this.pending.get(data.id);
        if (!pending) throw new Error(`Unexpected recording import response ${data.id}`);
        this.pending.delete(data.id);
        if (data.error) pending.reject(data.errorName === "AbortError" ? new DOMException(data.error, "AbortError") : new Error(data.error));
        else pending.resolve(data.value);
      };
      this.worker.onerror = (event) => this.terminate(new Error(`Recording import worker failed: ${event.message}`));
      this.opening = this.send("open", { recording: this.recording, score: this.score }, signal).then(() => undefined).catch((error: unknown) => {
        this.terminate(error instanceof Error ? error : new Error(String(error))); throw error;
      });
    }
    return this.opening;
  }

  async run(data: ArrayBuffer, signal?: AbortSignal): Promise<{ musicXml: string; notes: PianoNote[] }> {
    this.stage("Opening the recording");
    const [, decoded] = await Promise.all([this.prepare(signal), decodeAudioFile(data)]);
    signal?.throwIfAborted();
    try { return await this.send("run", { audio: decoded.audio.buffer }, signal, [decoded.audio.buffer]); }
    catch (error) { this.terminate(error instanceof Error ? error : new Error(String(error))); throw error; }
  }

  private send<T>(action: string, fields: object, signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> {
    if (!this.worker) return Promise.reject(new Error("Recording import is not initialized"));
    if (this.pending.size) return Promise.reject(new Error("Recording import is already running"));
    signal?.throwIfAborted();
    const id = ++this.sequence, worker = this.worker;
    return new Promise((resolve, reject) => {
      const abort = () => worker.postMessage({ action: "cancel", target: id });
      signal?.addEventListener("abort", abort, { once: true });
      const finish = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, {
        resolve: (value) => { finish(); resolve(value as T); },
        reject: (error) => { finish(); if (signal?.aborted) this.terminate(error); reject(error); },
      });
      worker.postMessage({ id, action, ...fields }, transfer);
    });
  }

  private terminate(error: Error): void {
    this.worker?.terminate(); this.worker = undefined; this.opening = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
