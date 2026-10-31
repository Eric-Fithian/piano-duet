import { KeyTracker } from "./key-tracker.ts";
import { comparePerformance } from "./performance-comparison.ts";
import { roundDecimal, roundEven } from "./numeric.ts";
import { assessVariation } from "./variation-assessment.ts";
import type { VariationDetail } from "./variation-analysis.ts";
import type { ContextNote } from "./aria-tokenizer.ts";
import type { MusicalKey } from "./musical-key.ts";
import type { LocalEventStore, LocalJsonValue } from "./local-service.ts";
import type { LocalPhraseTranscriber } from "./duet-service.ts";

export interface LocalVariationAnalyzer {
  run(notes: ContextNote[], threshold: number, signal?: AbortSignal,
    onNote?: (detail: VariationDetail, progress: number) => void): Promise<{ notes: ContextNote[]; analysis: VariationDetail[] }>;
}

export class VariationService {
  private readonly store: LocalEventStore;
  private readonly transcriber?: LocalPhraseTranscriber;
  private readonly analyzer?: LocalVariationAnalyzer;
  private readonly isBusy: () => boolean;
  private readonly setBusy: (busy: boolean) => void;
  private lesson: { id: string; session: string; notes: ContextNote[]; key: MusicalKey } | null = null;

  constructor(store: LocalEventStore, transcriber: LocalPhraseTranscriber | undefined, analyzer: LocalVariationAnalyzer | undefined,
    isBusy: () => boolean, setBusy: (busy: boolean) => void) {
    this.store = store; this.transcriber = transcriber; this.analyzer = analyzer; this.isBusy = isBusy; this.setBusy = setBusy;
  }

  async respond(url: URL, options: RequestInit): Promise<Response> {
    if (this.isBusy()) return Response.json({ detail: "The previous response is still finishing. Please retry." }, { status: 409 });
    const session = url.searchParams.get("session"), lessonId = url.searchParams.get("lesson"), stage = url.searchParams.get("stage") ?? "idea";
    const attemptId = url.searchParams.get("attempt") ?? crypto.randomUUID(), source = url.searchParams.get("source") ?? "microphone";
    const threshold = Number(url.searchParams.get("threshold") ?? 0.8), surprise = Number(url.searchParams.get("surprise") ?? 0.98);
    if (!validUuid(session) || !validUuid(attemptId) || !["idea", "repeat"].includes(stage) || !["microphone", "demo"].includes(source)
      || !Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.99 || !Number.isFinite(surprise) || surprise < 0 || surprise > 1
      || lessonId !== null && !validUuid(lessonId)) return Response.json({ detail: "Invalid Variations performance request" }, { status: 422 });
    if (!lessonId) return Response.json({ detail: "Learning requests require a round identifier" }, { status: 400 });
    if (url.searchParams.has("listening")) return Response.json({ detail: "Only drill takes carry what the live attack counter heard" }, { status: 400 });
    if (url.searchParams.has("task")) return Response.json({ detail: "An exercise target can only be used in practice or drills" }, { status: 400 });
    if (!this.transcriber || !this.analyzer || !this.store.append) return Response.json({ detail: "Variations is not available yet" }, { status: 501 });
    const body = options.body;
    if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return Response.json({ detail: "Expected mono float32 PCM at 16 kHz" }, { status: 400 });
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (bytes.byteLength < 6400 || bytes.byteLength % 4) return Response.json({ detail: "Expected mono float32 PCM at 16 kHz" }, { status: 400 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), audio = new Float32Array(bytes.byteLength / 4);
    let peak = 0, squares = 0;
    for (let index = 0; index < audio.length; index++) {
      const value = view.getFloat32(index * 4, true);
      if (!Number.isFinite(value)) return Response.json({ detail: "The microphone supplied non-finite audio samples. Re-enable the microphone and try again." }, { status: 400 });
      audio[index] = value; peak = Math.max(peak, Math.abs(value)); squares += value * value;
    }
    if (peak > 1) for (let index = 0; index < audio.length; index++) audio[index] /= peak;
    if ((await this.store.list()).some((event) => event.id === attemptId)) return Response.json({ detail: "This performance has already been saved" }, { status: 409 });
    if (this.isBusy()) return Response.json({ detail: "The previous response is still finishing. Please retry." }, { status: 409 });
    this.setBusy(true);
    const abort = new AbortController(), externalSignal = options.signal;
    const relay = () => abort.abort();
    externalSignal?.addEventListener("abort", relay, { once: true });
    if (externalSignal?.aborted) abort.abort();
    const transcriber = this.transcriber, analyzer = this.analyzer, store = this.store;
    const audioContext = { seconds: audio.length / 16000, peak, rms: roundDecimal(Math.sqrt(squares / audio.length), 6), note_threshold: threshold };
    const encoder = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const emit = (event: unknown) => { if (open) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
        const run = async () => {
          try {
            const started = performance.now();
            abort.signal.throwIfAborted();
            if (stage === "repeat" && (!this.lesson || this.lesson.session !== session || this.lesson.id !== lessonId)) {
              throw new Error("This learning target is no longer available. Start a new learning round.");
            }
            if (stage === "idea") this.lesson = null;
            emit({ type: "transcribing", progress: 0 });
            const { notes, quality } = await transcriber.run({ audio, sampleRate: 16000, threshold }, abort.signal);
            const transcriptionMs = roundEven(performance.now() - started);
            abort.signal.throwIfAborted();
            const key = stage === "repeat" ? this.lesson!.key : notes.length ? new KeyTracker().observe(notes) : null;
            const prompt = stage === "repeat" ? { title: "Play back the variation", family: "imitation", challenge: 1, target: this.lesson!.notes, key }
              : { title: "Your musical idea", target: [], family: "creating", challenge: 1 };
            const context = { notation_visible: false, hearings: 0, reveals: 0, hints: 0, familiar: false, source, family: prompt.family,
              audio: audioContext, session, surprise_threshold: surprise, estimated_key: key };
            const assessment = assessVariation(prompt.target, notes, key, source, quality);
            await store.append!("attempt", { mode: "learning", prompt, notes, context, recognition: quality, assessment } as unknown as LocalJsonValue, attemptId);
            emit({ type: "attempt", id: attemptId, assessment });
            emit({ type: "heard", notes, key, transcription_ms: transcriptionMs, stage });
            if (!notes.length) { emit({ type: "done", notes: 0, stage, empty: true }); return; }
            if (stage === "repeat") {
              const score = comparePerformance(this.lesson!.notes, notes);
              this.lesson = null;
              emit({ type: "score", ...score });
              emit({ type: "done", notes: 0, stage: "complete", total_ms: roundEven(performance.now() - started) });
              return;
            }
            if (!key) throw new Error("A musical idea needs an estimated key");
            const variation = await analyzer.run(notes, surprise, abort.signal, (_detail, progress) => emit({ type: "analyzing", progress }));
            abort.signal.throwIfAborted();
            this.lesson = { session: session!, id: lessonId, notes: variation.notes, key };
            emit({ type: "lesson", id: lessonId, notes: variation.notes, analysis: variation.analysis, threshold: surprise });
            const firstNoteMs = roundEven(performance.now() - started);
            for (const note of variation.notes) { abort.signal.throwIfAborted(); emit({ type: "note", note }); }
            emit({ type: "done", notes: variation.notes.length, stage: "repeat", first_note_ms: firstNoteMs,
              transcription_ms: transcriptionMs, total_ms: roundEven(performance.now() - started) });
          } catch (error) {
            if (!abort.signal.aborted) emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
          } finally {
            this.setBusy(false);
            externalSignal?.removeEventListener("abort", relay);
            if (open) { open = false; controller.close(); }
          }
        };
        void run();
      },
      cancel: () => { open = false; abort.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  }
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && value.split("-").map((part) => part.length).join(",") === "8,4,4,4,12"
    && [...value.replaceAll("-", "")].every((character) => "0123456789abcdefABCDEF".includes(character));
}
