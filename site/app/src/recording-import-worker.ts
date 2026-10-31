import * as ort from "onnxruntime-web/webgpu";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { scoreInput } from "../../../src/core/score-input.ts";
import { scoreMusicXml } from "../../../src/core/score-output.ts";
import type { ScoreInputNote } from "../../../src/core/score-input.ts";
import { describeInferenceBackend, initializeWithWebGPUFallback } from "./inference";
import type { InferenceBackendRecord } from "./inference";
import { ModelStore } from "./model-store";
import type { ModelAsset, ModelRole } from "./browser-inference";
import { RecordingPool } from "./recording-pool";
import { ScoreRuntime } from "./score-runtime";

type Request = { id: number; action: "open"; recording: ModelAsset[]; score: ModelAsset[] }
  | { id: number; action: "run"; audio: ArrayBuffer }
  | { id: number; action: "close" }
  | { action: "cancel"; target: number };

ort.env.wasm.numThreads = self.crossOriginIsolated ? navigator.hardwareConcurrency : 1;
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.origin).href,
  mjs: new URL(wasmModuleUrl, self.location.origin).href };
const store = new ModelStore(), controllers = new Map<number, AbortController>();
let pool: RecordingPool | undefined, score: ScoreRuntime | undefined, busy = false;

async function open(id: number, recording: ModelAsset[], files: ModelAsset[], signal: AbortSignal): Promise<InferenceBackendRecord> {
  if (pool || score) throw new Error("Recording import is already open");
  const cancellation = new AbortController();
  signal.throwIfAborted();
  signal.addEventListener("abort", () => cancellation.abort(), { once: true });
  const load = async (list: ModelAsset[], role: ModelRole) => {
    const matches = list.filter((asset) => asset.role === role);
    if (matches.length !== 1) throw new Error(`Recording import needs exactly one ${role} file`);
    return (await store.get(matches[0], (progress) => self.postMessage({ id, progress }), cancellation.signal)).arrayBuffer();
  };
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const provider = gpu && await gpu.requestAdapter() ? "webgpu" : "wasm";
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  const count = self.crossOriginIsolated && navigator.hardwareConcurrency >= 12 && memory >= 8 ? (memory >= 16 ? 4 : 3) : 1;
  let failure: unknown;
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) { failure ??= error; cancellation.abort(); throw error; }
  };
  const [written, transcriber] = await Promise.allSettled([
    guard(async () => {
      const encoder = await load(files, "score-encoder"), first = await load(files, "score-first");
      const context = await load(files, "score-context"), step = await load(files, "score-step");
      cancellation.signal.throwIfAborted();
      return initializeWithWebGPUFallback("midi-to-score", provider,
        (selected) => ScoreRuntime.open({ encoder, first, context, step }, selected), cancellation.signal);
    }),
    guard(async () => {
      const features = await load(recording, "features"), attributes = await load(recording, "attributes");
      cancellation.signal.throwIfAborted();
      return RecordingPool.open(features, attributes, count, Math.max(1, Math.floor(navigator.hardwareConcurrency / count)));
    }),
  ]);
  if (written.status === "fulfilled") score = written.value.value;
  if (transcriber.status === "fulfilled") pool = transcriber.value;
  if (written.status === "rejected" || transcriber.status === "rejected") throw failure ?? new Error("Could not initialize recording import");
  signal.throwIfAborted();
  if (written.status !== "fulfilled") throw new Error("Score model did not initialize");
  self.postMessage({ id, stage: `Ready · ${describeInferenceBackend({ model: "midi-to-score", ...written.value.backend })}` });
  return written.value.backend;
}

async function run(id: number, audio: Float32Array, signal: AbortSignal): Promise<{ musicXml: string; notes: ScoreInputNote[] }> {
  if (!pool || !score) throw new Error("Recording import is not open");
  let resolveFirst!: (notes: ScoreInputNote[]) => void;
  let rejectFirst!: (error: unknown) => void;
  const first = new Promise<ScoreInputNote[]>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  let started = false;
  self.postMessage({ id, stage: "Finding the notes" });
  const transcribing = pool.run(audio, signal, (notes) => {
    if (!started && notes.length >= 512 && scoreInput(notes).pad.length >= 512) {
      started = true; resolveFirst(notes);
      self.postMessage({ id, stage: "Finding the notes and writing the score" });
    }
  });
  const complete = transcribing.then((notes) => {
    if (!started) { started = true; resolveFirst(notes); }
    self.postMessage({ id, stage: "Writing the score" });
    return scoreInput(notes);
  });
  complete.catch((error: unknown) => { if (!started) rejectFirst(error); });
  const initial = scoreInput(await first);
  const tokens = await score.generate(initial, signal, complete);
  return { musicXml: scoreMusicXml(tokens), notes: await transcribing };
}

async function close(): Promise<void> {
  pool?.close(); pool = undefined;
  await score?.close(); score = undefined;
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  if (data.action === "cancel") { controllers.get(data.target)?.abort(); return; }
  if (busy) { self.postMessage({ id: data.id, error: "Recording import is already running" }); return; }
  busy = true;
  const controller = new AbortController(); controllers.set(data.id, controller);
  try {
    const value = data.action === "open" ? await open(data.id, data.recording, data.score, controller.signal)
      : data.action === "run" ? await run(data.id, new Float32Array(data.audio), controller.signal) : await close();
    self.postMessage({ id: data.id, value });
  } catch (error) {
    await close();
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "Error", errorStack: error instanceof Error ? error.stack : undefined,
      errorCauses: error instanceof AggregateError ? error.errors.map((cause: unknown) => ({
        message: cause instanceof Error ? cause.message : String(cause), name: cause instanceof Error ? cause.name : "Error",
        stack: cause instanceof Error ? cause.stack : undefined,
      })) : undefined });
  } finally { controllers.delete(data.id); busy = false; }
};
