import * as ort from "onnxruntime-web/webgpu";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { decodeLiveOnsets } from "./live-onsets";
import { transcribeRecording } from "./recording-runtime";
import { transcribePhrase } from "./phrase-runtime";
import { RecordingPool } from "./recording-pool";
import { ScoreRuntime } from "./score-runtime";
import { resample16To441 } from "../../../src/core/resample.ts";
import { scoreInput } from "../../../src/core/score-input.ts";
import { scoreMusicXml } from "../../../src/core/score-output.ts";
import { ModelStore } from "./model-store";
import type { ModelAsset, ModelRole } from "./browser-inference";
import type { ModelId, ModelInputs } from "./inference";

type Request =
  | { id: number; action: "open"; model: ModelId; files: ModelAsset[]; preference: "auto" | "wasm" }
  | { id: number; action: "run"; input: ModelInputs[ModelId] }
  | { id: number; action: "close" }
  | { action: "cancel"; target: number };

const wasmThreads = self.crossOriginIsolated ? navigator.hardwareConcurrency : 1;
ort.env.wasm.numThreads = wasmThreads;
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.origin).href,
  mjs: new URL(wasmModuleUrl, self.location.origin).href };

let model: ModelId | undefined;
let provider: "webgpu" | "wasm";
let session: ort.InferenceSession | undefined;
let recurrent: ort.InferenceSession | undefined;
let recordingPool: RecordingPool | undefined;
let scoreRuntime: ScoreRuntime | undefined;
let cache: Record<string, ort.Tensor> = {};
const controllers = new Map<number, AbortController>();
const store = new ModelStore();
let busy = false;

async function open(id: number, name: ModelId, files: ModelAsset[], preference: "auto" | "wasm", signal: AbortSignal): Promise<{ provider: "webgpu" | "wasm"; recordingWorkers?: { provider: "wasm"; threads: number }[] }> {
  if (session || recordingPool || scoreRuntime) throw new Error("The inference session is already open");
  if (files.some((file) => file.model !== name)) throw new Error("Model catalog contains a mismatched file");
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  provider = name !== "recording-transcription" && (name !== "phrase-transcription" || files.some((file) => file.role === "convolution"))
    && preference === "auto" && gpu && await gpu.requestAdapter() ? "webgpu" : "wasm";
  const asset = async (role: ModelRole): Promise<Response> => {
    const matches = files.filter((file) => file.role === role);
    if (matches.length !== 1) throw new Error(`${name} needs exactly one ${role} file`);
    return store.get(matches[0], (progress) => self.postMessage({ progress, id }), signal);
  };
  const options: ort.InferenceSession.SessionOptions = { executionProviders: [provider] };
  if (name === "aria") {
    const graph = await (await asset("graph")).arrayBuffer();
    const weights = files.find((file) => file.role === "weights");
    if (!weights) throw new Error("Aria weights are missing");
    const external = await (await asset("weights")).blob();
    options.externalData = [{ path: weights.name, data: external }];
    if (provider === "webgpu") {
      options.preferredOutputLocation = Object.fromEntries(Array.from({ length: 16 }, (_, index) =>
        ["key", "value"].map((kind) => [`present_${kind}_${index}`, "gpu-buffer"])).flat());
    }
    session = await ort.InferenceSession.create(graph, options);
    resetCache();
  } else if (name === "phrase-transcription") {
    if (provider === "webgpu") {
      const convolution = await (await asset("convolution")).arrayBuffer();
      const remainder = await (await asset("recurrent")).arrayBuffer();
      try {
        session = await ort.InferenceSession.create(convolution, { executionProviders: ["webgpu"], graphOptimizationLevel: "disabled" });
        recurrent = await ort.InferenceSession.create(remainder, { executionProviders: ["wasm"], graphOptimizationLevel: "disabled" });
      } catch (error) {
        await session?.release(); session = undefined;
        provider = "wasm";
        console.info(`Phrase transcription is using WASM: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (provider === "wasm") {
      const graph = await (await asset("graph")).arrayBuffer();
      session = await ort.InferenceSession.create(graph, { executionProviders: ["wasm"], graphOptimizationLevel: "disabled" });
    }
  } else if (name === "recording-transcription") {
    const features = await (await asset("features")).arrayBuffer();
    const attributes = await (await asset("attributes")).arrayBuffer();
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
    const count = self.crossOriginIsolated && navigator.hardwareConcurrency >= 12 && memory >= 8 ? (memory >= 16 ? 4 : 3) : 1;
    if (count > 1) recordingPool = await RecordingPool.open(features, attributes, count, Math.floor(navigator.hardwareConcurrency / count));
    else {
      session = await ort.InferenceSession.create(features, { executionProviders: ["wasm"] });
      recurrent = await ort.InferenceSession.create(attributes, { executionProviders: ["wasm"] });
    }
  } else if (name === "midi-to-score") {
    const encoder = await (await asset("score-encoder")).arrayBuffer();
    const first = await (await asset("score-first")).arrayBuffer();
    const context = await (await asset("score-context")).arrayBuffer();
    const step = await (await asset("score-step")).arrayBuffer();
    scoreRuntime = await ScoreRuntime.open({ encoder, first, context, step }, provider);
  } else {
    options.graphOptimizationLevel = "disabled";
    if (provider === "webgpu") {
      const convolution = await (await asset("convolution")).arrayBuffer();
      const remainder = await (await asset("recurrent")).arrayBuffer();
      session = await ort.InferenceSession.create(convolution, options);
      recurrent = await ort.InferenceSession.create(remainder, { ...options, executionProviders: ["wasm"] });
    } else {
      const graph = await (await asset("graph")).arrayBuffer();
      session = await ort.InferenceSession.create(graph, options);
    }
  }
  model = name;
  signal.throwIfAborted();
  return { provider, ...(name === "recording-transcription" ? { recordingWorkers: recordingPool?.diagnostics
    ?? [{ provider: "wasm" as const, threads: wasmThreads }] } : {}) };
}

function resetCache(): void {
  if (!session) throw new Error("Aria is not open");
  for (const tensor of Object.values(cache)) tensor.dispose();
  const names = Array.from({ length: 16 }, (_, index) => ["key", "value"].map((kind) => `past_${kind}_${index}`)).flat();
  if (names.some((name) => !session?.inputNames.includes(name))) throw new Error("Unexpected Aria cache inputs");
  cache = Object.fromEntries(names.map((name) => [name, new ort.Tensor("float32", new Float32Array(0), [1, 24, 0, 64])]));
}

async function run(input: ModelInputs[ModelId], signal: AbortSignal): Promise<unknown> {
  if (!model) throw new Error("The inference session is not open");
  if (model === "midi-to-score") {
    if (!scoreRuntime) throw new Error("Score writing is not open");
    const { notes } = input as ModelInputs["midi-to-score"];
    const tokens = await scoreRuntime.generate(scoreInput(notes), signal);
    return { musicXml: scoreMusicXml(tokens) };
  }
  if (model === "recording-transcription") {
    const recording = input as ModelInputs["recording-transcription"];
    if (recording.sampleRate !== 16000 && recording.sampleRate !== 44100) throw new Error("Recording transcription needs 16 kHz or 44.1 kHz audio");
    const audio = recording.sampleRate === 16000 ? resample16To441(recording.audio) : recording.audio;
    signal.throwIfAborted();
    if (recordingPool) return { notes: await recordingPool.run(audio, signal) };
    if (!session || !recurrent) throw new Error("Recording transcription is not open");
    return { notes: await transcribeRecording(session, recurrent, audio, signal) };
  }
  if (!session) throw new Error("The inference session is not open");
  if (model === "phrase-transcription") return transcribePhrase(session, recurrent, input as ModelInputs["phrase-transcription"], signal);
  if (model === "aria") {
    const { tokens, reset, commit = true } = input as ModelInputs["aria"];
    if (!tokens.length || tokens.some((token) => !Number.isSafeInteger(token) || token < 0)) throw new Error("Aria needs valid token IDs");
    if (reset) resetCache();
    const previous = cache;
    const result = await session.run({ tokens: new ort.Tensor("int64", BigInt64Array.from(tokens.map(BigInt)), [1, tokens.length]), ...cache });
    const next = Object.fromEntries(Object.keys(cache).map((name) => {
      const tensor = result[name.replace("past_", "present_")];
      if (!tensor) throw new Error(`Aria did not return ${name}`);
      return [name, tensor as ort.Tensor];
    }));
    if (commit) {
      cache = next;
      for (const tensor of Object.values(previous)) tensor.dispose();
    } else {
      for (const tensor of Object.values(next)) tensor.dispose();
    }
    const output = result.logits;
    if (!output || output.type !== "float32") throw new Error("Unexpected Aria logits");
    const values = output.data as Float32Array;
    const vocabulary = output.dims.at(-1);
    if (!vocabulary) throw new Error("Aria did not return a vocabulary dimension");
    const logits = values.slice(-vocabulary);
    output.dispose();
    signal.throwIfAborted();
    return { logits };
  }
  const live = input as ModelInputs["live-transcription"];
  if (live.sampleRate !== 16000 || live.audio.length !== 32000 || live.audio.some((sample) => !Number.isFinite(sample))
      || !Number.isFinite(live.threshold) || live.threshold < 0.1 || live.threshold > 0.99) throw new Error("Live transcription needs two seconds of finite 16 kHz audio");
  const audio = new ort.Tensor("float32", live.audio, [1, live.audio.length]);
  const intermediate = recurrent ? await session.run({ [session.inputNames[0]]: audio }) : null;
  const result = await (recurrent ?? session).run(intermediate ?? { [session.inputNames[0]]: audio }, ["reg_onset", "frame", "velocity"]);
  const onset = result.reg_onset, frame = result.frame, velocity = result.velocity;
  if (!onset || !frame || !velocity || onset.type !== "float32" || frame.type !== "float32" || velocity.type !== "float32"
      || onset.dims.length !== 3 || onset.dims[0] !== 1 || onset.dims[2] !== 88) throw new Error("Unexpected transcription outputs");
  const notes = decodeLiveOnsets(onset.data as Float32Array, frame.data as Float32Array,
    velocity.data as Float32Array, onset.dims[1], live.threshold);
  for (const tensor of [...Object.values(intermediate ?? {}), ...Object.values(result)]) tensor.dispose();
  audio.dispose();
  signal.throwIfAborted();
  return { notes };
}

async function close(): Promise<void> {
  for (const tensor of Object.values(cache)) tensor.dispose();
  cache = {};
  await session?.release();
  await recurrent?.release();
  recordingPool?.close();
  await scoreRuntime?.close();
  scoreRuntime = undefined;
  recordingPool = undefined;
  session = recurrent = undefined;
  model = undefined;
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  if (data.action === "cancel") { controllers.get(data.target)?.abort(); return; }
  if (busy) { self.postMessage({ id: data.id, error: "The inference session is already running" }); return; }
  busy = true;
  const controller = new AbortController();
  controllers.set(data.id, controller);
  try {
    const value = data.action === "open" ? await open(data.id, data.model, data.files, data.preference, controller.signal)
      : data.action === "run" ? await run(data.input, controller.signal) : await close();
    self.postMessage({ id: data.id, value });
  } catch (error) {
    if (controller.signal.aborted) await close();
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "Error" });
  } finally {
    controllers.delete(data.id);
    busy = false;
  }
};
