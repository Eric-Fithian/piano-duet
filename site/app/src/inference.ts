export type ModelId = "aria" | "live-transcription" | "recording-transcription" | "midi-to-score";
export type AssetId = ModelId | "piano-samples";

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
  "recording-transcription": { audio: Float32Array; sampleRate: 16000 | 44100 };
  "midi-to-score": { notes: PianoNote[] };
}

export interface ModelOutputs {
  aria: { logits: Float32Array };
  "live-transcription": { notes: LiveOnset[] };
  "recording-transcription": { notes: PianoNote[] };
  "midi-to-score": { musicXml: string };
}

export interface DownloadProgress {
  model: AssetId;
  file: string;
  received: number;
  total: number | null;
}

export interface InferenceSession<K extends ModelId> {
  readonly model: K;
  readonly provider: "webgpu" | "wasm" | "native";
  run(input: ModelInputs[K], signal?: AbortSignal): Promise<ModelOutputs[K]>;
  close(): Promise<void>;
}

export interface InferenceBackend {
  createSession<K extends ModelId>(model: K, onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal): Promise<InferenceSession<K>>;
}
