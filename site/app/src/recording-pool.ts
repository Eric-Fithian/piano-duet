import { recordingFrames, RecordingAssembler, RECORDING_PAD, RECORDING_STEP } from "../../../src/core/recording-segments.ts";
import type { recordingEvents } from "../../../src/core/recording-segments.ts";
import type { PianoNote } from "./inference";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
class RecordingWorker {
  private worker = new Worker(new URL("./recording-pool-worker.ts", import.meta.url), { type: "module" });
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
      const pending = this.pending.get(data.id);
      if (!pending) throw new Error(`Unexpected recording worker response ${data.id}`);
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.value);
    };
    this.worker.onerror = (event) => this.terminate(new Error(`Recording worker failed: ${event.message}`));
  }

  send<T>(message: object, transfer: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Recording worker is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  terminate(error = new Error("Recording worker closed")): void {
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class RecordingPool {
  private readonly workers: RecordingWorker[];
  private closed = false;
  diagnostics: { provider: "wasm"; threads: number }[] = [];

  private constructor(count: number) {
    this.workers = Array.from({ length: count }, () => new RecordingWorker());
  }

  static async open(features: ArrayBuffer, attributes: ArrayBuffer, count: number, threads: number): Promise<RecordingPool> {
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(threads) || threads < 1) throw new Error("Invalid recording worker configuration");
    const pool = new RecordingPool(count);
    try {
      const diagnostics = await Promise.all(pool.workers.map((worker) => worker.send<{ provider: string; threads: number }>({ action: "open", features, attributes, threads })));
      if (diagnostics.some((item) => item.provider !== "wasm" || item.threads !== threads)) throw new Error("Unexpected recording worker backend");
      pool.diagnostics = diagnostics as { provider: "wasm"; threads: number }[];
      return pool;
    } catch (error) {
      pool.close();
      throw error;
    }
  }

  async run(audio: Float32Array, signal: AbortSignal): Promise<PianoNote[]> {
    if (this.closed) throw new Error("Recording pool is closed");
    if (!audio.length || audio.some((sample) => !Number.isFinite(sample))) throw new Error("Recording transcription needs finite audio");
    const assembly = new RecordingAssembler(audio.length);
    const length = Math.ceil((audio.length + 2 * RECORDING_PAD) / RECORDING_STEP), count = this.workers.length;
    const inflight = new Map<number, Promise<Error | undefined>>();
    const schedule = (index: number) => {
      const frames = recordingFrames(audio, index * RECORDING_STEP);
      const job = this.workers[index % count].send({ action: "compute", frames: frames.buffer }, [frames.buffer])
        .then(() => undefined, (error: unknown) => error instanceof Error ? error : new Error(String(error)));
      inflight.set(index, job);
    };
    try {
      for (let index = 0; index < Math.min(count, length); index++) schedule(index);
      for (let index = 0; index < length; index++) {
        signal.throwIfAborted();
        const pending = inflight.get(index);
        if (!pending) throw new Error(`Recording segment ${index} was not scheduled`);
        const error = await pending;
        if (error) throw error;
        inflight.delete(index);
        signal.throwIfAborted();
        const worker = this.workers[index % count];
        const segment = await worker.send<ReturnType<typeof recordingEvents>>({ action: "decode", positions: assembly.positions });
        assembly.accept(index * RECORDING_STEP, segment);
        if (index + count < length) schedule(index + count);
      }
      signal.throwIfAborted();
      return assembly.finish();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.workers.forEach((worker) => worker.terminate());
  }
}
