import { learnerProfile } from "./learner-profile.ts";
import { attemptsFromEvents } from "./reading-events.ts";
import type { ReadingLogEvent } from "./reading-events.ts";

export interface LocalEventStore { list(): Promise<ReadingLogEvent[]> }
export interface LocalTranscriber {
  run(input: { audio: Float32Array; sampleRate: 16000; threshold: number }, signal?: AbortSignal): Promise<{ notes: unknown[] }>;
}

export class LocalService {
  private readingBusy = false;
  private readonly store: LocalEventStore;
  private readonly transcriber?: LocalTranscriber;
  private readonly now: () => number;

  constructor(store: LocalEventStore, transcriber?: LocalTranscriber, now: () => number = () => Date.now() / 1000) {
    this.store = store;
    this.transcriber = transcriber;
    this.now = now;
  }

  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    options.signal?.throwIfAborted();
    const url = new URL(path, "http://piano.local");
    if (url.origin !== "http://piano.local") throw new Error("Local service requests must use a local path");
    const method = (options.method ?? "GET").toUpperCase();
    if (method === "GET" && url.pathname === "/api/status") {
      return Response.json({ application: "piano-duet", development: false, ready: true, busy: this.readingBusy,
        model: "Aria · ONNX 4-bit", sample_rate: 16000 });
    }
    if (method === "GET" && url.pathname === "/api/profile") {
      return Response.json(learnerProfile(attemptsFromEvents(await this.store.list()), this.now()));
    }
    if (method === "GET" && url.pathname === "/api/pieces") {
      const events = await this.store.list();
      const pieces = events.filter((event) => event.kind === "song" && isPiece(event.payload)).map((event) => (event.payload as { piece: unknown }).piece);
      return Response.json(pieces);
    }
    if (method === "POST" && url.pathname === "/api/reading/listen") return this.listen(url, options);
    return Response.json({ detail: `Local service does not yet implement ${method} ${url.pathname}` }, { status: 501 });
  }

  private async listen(url: URL, options: RequestInit): Promise<Response> {
    const threshold = url.searchParams.has("threshold") ? Number(url.searchParams.get("threshold")) : 0.8;
    if (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.99) return Response.json({ detail: "Invalid note threshold" }, { status: 422 });
    if (this.readingBusy) return Response.json({ detail: "The piano is processing another performance" }, { status: 409 });
    const body = options.body;
    if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
      return Response.json({ detail: "Live reading expects two seconds of mono float32 PCM at 16 kHz" }, { status: 400 });
    }
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (bytes.byteLength !== 32000 * 4) return Response.json({ detail: "Live reading expects two seconds of mono float32 PCM at 16 kHz" }, { status: 400 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const audio = new Float32Array(32000);
    let peak = 0;
    for (let index = 0; index < audio.length; index++) {
      const value = view.getFloat32(index * 4, true);
      if (!Number.isFinite(value)) return Response.json({ detail: "The microphone supplied non-finite audio" }, { status: 400 });
      audio[index] = value;
      peak = Math.max(peak, Math.abs(value));
    }
    if (!this.transcriber) return Response.json({ detail: "Live transcription is not available yet" }, { status: 501 });
    if (peak > 1) for (let index = 0; index < audio.length; index++) audio[index] /= peak;
    this.readingBusy = true;
    const started = performance.now();
    try {
      const result = await this.transcriber.run({ audio, sampleRate: 16000, threshold }, options.signal ?? undefined);
      return Response.json({ notes: result.notes, inference_ms: Math.round(performance.now() - started) });
    } finally {
      this.readingBusy = false;
    }
  }
}

function isPiece(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "piece" && "piece" in value;
}
