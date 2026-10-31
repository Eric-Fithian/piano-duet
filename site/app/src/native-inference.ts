import type { DownloadProgress, InferenceBackend, InferenceSession, ModelId, ModelInputs, ModelOutputs } from "./inference.ts";

export interface NativeInferenceTransport {
  request(message: Record<string, unknown>, signal?: AbortSignal, onProgress?: (progress: DownloadProgress) => void): Promise<unknown>;
}

export class NativeInference implements InferenceBackend {
  private readonly transport: NativeInferenceTransport;

  constructor(transport: NativeInferenceTransport) { this.transport = transport; }

  async createSession<K extends ModelId>(model: K, onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal): Promise<InferenceSession<K>> {
    signal?.throwIfAborted();
    const reply = await this.transport.request({ action: "open", model }, signal, onProgress);
    if (!isObject(reply) || typeof reply.session !== "string" || !reply.session) throw new Error("Native inference returned an invalid session");
    return new NativeSession(model, reply.session, this.transport);
  }
}

class NativeSession<K extends ModelId> implements InferenceSession<K> {
  readonly model: K;
  readonly provider = "native" as const;
  private busy = false;
  private closed = false;
  private readonly id: string;
  private readonly transport: NativeInferenceTransport;

  constructor(model: K, id: string, transport: NativeInferenceTransport) { this.model = model; this.id = id; this.transport = transport; }

  async run(input: ModelInputs[K], signal?: AbortSignal): Promise<ModelOutputs[K]> {
    if (this.closed) throw new Error("The inference session is closed");
    if (this.busy) throw new Error("The inference session is already running");
    signal?.throwIfAborted();
    this.busy = true;
    try {
      const reply = await this.transport.request({ action: "run", session: this.id, input: encode(input) }, signal);
      signal?.throwIfAborted();
      const result = decode(reply);
      if (!isObject(result)) throw new Error("Native inference returned an invalid result");
      if (this.model === "aria" && (!(result.logits instanceof Float32Array) || !result.logits.length)) throw new Error("Native Aria returned invalid logits");
      if (["live-transcription", "phrase-transcription", "recording-transcription"].includes(this.model) && !Array.isArray(result.notes)) {
        throw new Error("Native transcription returned invalid notes");
      }
      if (this.model === "phrase-transcription" && !isObject(result.quality)) throw new Error("Native phrase transcription returned invalid quality");
      if (this.model === "midi-to-score" && typeof result.musicXml !== "string") throw new Error("Native score writing returned invalid MusicXML");
      return result as unknown as ModelOutputs[K];
    } finally { this.busy = false; }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.busy) throw new Error("The inference session is already running");
    await this.transport.request({ action: "close", session: this.id });
    this.closed = true;
  }
}

function encode(value: unknown): unknown {
  if (value instanceof Float32Array) {
    if (value.some((item) => !Number.isFinite(item))) throw new Error("Native inference needs finite float data");
    const bytes = new Uint8Array(value.length * 4), view = new DataView(bytes.buffer);
    for (let index = 0; index < value.length; index++) view.setFloat32(index * 4, value[index], true);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return { $type: "float32-le", data: btoa(binary) };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Native inference input contains an unsupported value");
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (isObject(value)) {
    if (value.$type === "float32-le") {
      if (typeof value.data !== "string") throw new Error("Native inference returned invalid float data");
      const binary = atob(value.data);
      if (binary.length % 4) throw new Error("Native inference returned truncated float data");
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)), view = new DataView(bytes.buffer);
      return Float32Array.from({ length: bytes.length / 4 }, (_, index) => view.getFloat32(index * 4, true));
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Native inference returned an unsupported value");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
