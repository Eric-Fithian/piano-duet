export type ModelId = "aria" | "live-transcription" | "phrase-transcription" | "recording-transcription" | "midi-to-score";
export type AssetId = ModelId | "piano-samples";

export interface ModelFile {
  model: AssetId;
  name: string;
  revision: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface PianoNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export interface LiveOnset {
  pitch: number;
  start: number;
  velocity: number;
  confidence: number;
}

export interface ModelInputs {
  aria: { tokens: number[]; reset: boolean; commit?: boolean };
  "live-transcription": { audio: Float32Array; sampleRate: 16000; threshold: number };
  "phrase-transcription": { audio: Float32Array; sampleRate: 16000; threshold: number };
  "recording-transcription": { audio: Float32Array; sampleRate: 16000 | 44100 };
  "midi-to-score": { notes: PianoNote[] };
}

export interface ModelOutputs {
  aria: { logits: Float32Array };
  "live-transcription": { notes: LiveOnset[] };
  "phrase-transcription": { notes: PianoNote[]; quality: { usable: boolean; onset_support: number | null; supported_fraction: number;
    note_support: number[]; reason: string } };
  "recording-transcription": { notes: PianoNote[] };
  "midi-to-score": { musicXml: string };
}

export interface DownloadProgress {
  model: AssetId;
  file: string;
  received: number;
  total: number | null;
}

export interface InferenceBackendRecord {
  readonly provider: "webgpu" | "wasm" | "native";
  readonly fallback?: { provider: "webgpu"; message: string; stack?: string };
}

export interface InferenceSession<K extends ModelId> extends InferenceBackendRecord {
  readonly model: K;
  run(input: ModelInputs[K], signal?: AbortSignal): Promise<ModelOutputs[K]>;
  close(): Promise<void>;
}

export interface InferenceBackend {
  createSession<K extends ModelId>(model: K, onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal): Promise<InferenceSession<K>>;
}

export function describeInferenceBackend(session: InferenceBackendRecord & { model: ModelId }): string {
  const provider = session.provider === "wasm" ? "CPU" : session.provider === "webgpu" ? "WebGPU" : "Native";
  return `${session.model}: ${provider}${session.fallback ? ` (WebGPU failed: ${session.fallback.message})` : ""}`;
}

export async function initializeWithWebGPUFallback<T>(model: ModelId, provider: "webgpu" | "wasm",
  initialize: (provider: "webgpu" | "wasm") => Promise<T>, signal?: AbortSignal): Promise<{ value: T; backend: InferenceBackendRecord }> {
  signal?.throwIfAborted();
  try { return { value: await initialize(provider), backend: { provider } }; }
  catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (provider !== "webgpu" || !(error instanceof Error) || error.name !== "WebGPUInitializationError") throw error;
    console.info(`WebGPU could not initialize ${model}; retrying with WASM: ${error.message}\n${error.stack ?? ""}`);
    const fallback = { provider: "webgpu" as const, message: error.message, stack: error.stack };
    try { return { value: await initialize("wasm"), backend: { provider: "wasm", fallback } }; }
    catch (fallbackError) {
      if (signal?.aborted) throw signal.reason;
      const reason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new AggregateError([error, fallbackError], `Could not initialize ${model}: WebGPU: ${error.message}; CPU: ${reason}`);
    }
  }
}
