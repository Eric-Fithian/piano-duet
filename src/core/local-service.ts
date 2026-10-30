import { learnerProfile } from "./learner-profile.ts";
import { initialPracticeTask } from "./initial-practice.ts";
import { attemptsFromEvents } from "./reading-events.ts";
import type { ReadingLogEvent } from "./reading-events.ts";

export interface LocalEventStore { list(): Promise<ReadingLogEvent[]> }
export interface LocalTranscriber {
  run(input: { audio: Float32Array; sampleRate: 16000; threshold: number }, signal?: AbortSignal): Promise<{ notes: unknown[] }>;
}
export interface LocalAssets { fetch(path: string, options?: RequestInit): Promise<Response> }

export class LocalService {
  private readingBusy = false;
  private readonly store: LocalEventStore;
  private readonly transcriber?: LocalTranscriber;
  private readonly now: () => number;
  private readonly assets?: LocalAssets;
  private readonly tasks = new Map<string, ReturnType<typeof initialPracticeTask>>();

  constructor(store: LocalEventStore, transcriber?: LocalTranscriber, now: () => number = () => Date.now() / 1000, assets?: LocalAssets) {
    this.store = store;
    this.transcriber = transcriber;
    this.now = now;
    this.assets = assets;
  }

  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    options.signal?.throwIfAborted();
    const url = new URL(path, "http://piano.local");
    if (url.origin !== "http://piano.local") throw new Error("Local service requests must use a local path");
    const method = (options.method ?? "GET").toUpperCase();
    if (url.pathname.startsWith("/samples/")) {
      if (!this.assets) return Response.json({ detail: "Piano samples are not available yet" }, { status: 501 });
      return this.assets.fetch(url.pathname, options);
    }
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
    if (method === "POST" && url.pathname === "/api/practice/next") {
      if (typeof options.body !== "string") return Response.json({ detail: "A practice request needs JSON" }, { status: 400 });
      const request = JSON.parse(options.body) as { focus?: string; step_by_step?: boolean; piece?: string | null; stage?: number | null; after?: string | null };
      const focus = request.focus ?? "guided";
      if (request.step_by_step && focus !== "reading") return Response.json({ detail: "Step-by-step practice requires the reading focus" }, { status: 400 });
      const attempts = attemptsFromEvents(await this.store.list());
      if ((focus === "guided" || focus === "technique") && !attempts.length && !request.piece && !request.stage && !request.after) {
        const task = initialPracticeTask(crypto.randomUUID(), focus);
        this.tasks.set(task.id, task);
        return Response.json(task);
      }
      return Response.json({ detail: "This practice selection is not available yet" }, { status: 501 });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "practice" && parts[3] === "aid") {
      const task = this.tasks.get(parts[2]);
      if (!task) return Response.json({ detail: "Choose an unfinished exercise first" }, { status: 409 });
      if (typeof options.body !== "string") return Response.json({ detail: "An aid request needs JSON" }, { status: 400 });
      const request = JSON.parse(options.body) as { kind?: "hearings" | "reveals" | "hints" };
      if (request.kind !== "hearings" && request.kind !== "reveals" && request.kind !== "hints") return Response.json({ detail: "Invalid aid" }, { status: 422 });
      task.context[request.kind]++;
      return Response.json(task);
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
