import { KeyTracker } from "./key-tracker.ts";
import { roundDecimal, roundEven } from "./numeric.ts";
import type { ContextNote } from "./aria-tokenizer.ts";
import type { LocalEventStore, LocalJsonValue } from "./local-service.ts";

export interface LocalPhraseTranscriber {
  run(input: { audio: Float32Array; sampleRate: 16000; threshold: number }, signal?: AbortSignal): Promise<{
    notes: ContextNote[]; quality: { usable: boolean; onset_support: number | null; supported_fraction: number; note_support: number[]; reason: string };
  }>;
}
export interface LocalDuetGenerator {
  generate(input: { notes: ContextNote[]; seconds: number; temperature: number; difficulty: number; tonic: number; pitchClasses: number[] },
    signal?: AbortSignal): AsyncIterable<ContextNote>;
}
export class DuetService {
  private readonly store: LocalEventStore;
  private readonly phraseTranscriber?: LocalPhraseTranscriber;
  private readonly duetGenerator?: LocalDuetGenerator;
  private readonly isBusy: () => boolean;
  private readonly setBusy: (busy: boolean) => void;
  private duetSession: string | null = null;
  private duetHistory: ContextNote[] = [];
  private duetKey = new KeyTracker();

  constructor(store: LocalEventStore, phraseTranscriber: LocalPhraseTranscriber | undefined, duetGenerator: LocalDuetGenerator | undefined,
    isBusy: () => boolean, setBusy: (busy: boolean) => void) {
    this.store = store; this.phraseTranscriber = phraseTranscriber; this.duetGenerator = duetGenerator;
    this.isBusy = isBusy; this.setBusy = setBusy;
  }

  async respond(url: URL, options: RequestInit): Promise<Response> {
    if (this.isBusy()) return Response.json({ detail: "The previous response is still finishing. Please retry." }, { status: 409 });
    const session = url.searchParams.get("session"), suppliedAttempt = url.searchParams.get("attempt");
    const attemptId = suppliedAttempt ?? crypto.randomUUID(), source = url.searchParams.get("source") ?? "microphone";
    const seconds = Number(url.searchParams.get("seconds") ?? 5), temperature = Number(url.searchParams.get("temperature") ?? 0.95);
    const threshold = Number(url.searchParams.get("threshold") ?? 0.8), difficulty = Number(url.searchParams.get("difficulty") ?? 3);
    if (!validUuid(session) || !validUuid(attemptId) || !["microphone", "demo"].includes(source)
      || !Number.isFinite(seconds) || seconds < 2 || seconds > 12 || !Number.isFinite(temperature) || temperature < 0.5 || temperature > 1.3
      || !Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.99 || !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
      return Response.json({ detail: "Invalid Duet performance request" }, { status: 422 });
    }
    if (url.searchParams.has("listening")) return Response.json({ detail: "Only drill takes carry what the live attack counter heard" }, { status: 400 });
    if (url.searchParams.has("task")) return Response.json({ detail: "An exercise target can only be used in practice or drills" }, { status: 400 });
    if (!this.phraseTranscriber || !this.duetGenerator || !this.store.append) return Response.json({ detail: "Duet is not available yet" }, { status: 501 });
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
    const transcriber = this.phraseTranscriber, generator = this.duetGenerator, store = this.store;
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
            emit({ type: "transcribing", progress: 0 });
            const { notes, quality } = await transcriber.run({ audio, sampleRate: 16000, threshold }, abort.signal);
            const transcriptionMs = roundEven(performance.now() - started);
            abort.signal.throwIfAborted();
            if (this.duetSession !== session) { this.duetSession = session; this.duetHistory = []; this.duetKey = new KeyTracker(); }
            const key = notes.length ? this.duetKey.observe(notes) : null;
            const prompt = { title: "Duet phrase", target: [], family: "creating", challenge: 1, preceding_music: this.duetHistory };
            const context = { notation_visible: false, hearings: 0, reveals: 0, hints: 0, familiar: false, source, family: "creating", audio: audioContext,
              session, reply_settings: { difficulty, temperature, seconds }, estimated_key: key };
            const assessment = { version: 1, score: null, observations: [], evidence: [], quality,
              feedback: notes.length ? "Saved as musical exploration. There is no intended sequence to grade." : "No piano notes were recognized. Your levels have not changed.",
              ...(notes.length ? { observed: { range: [Math.min(...notes.map((note) => note.pitch)), Math.max(...notes.map((note) => note.pitch))],
                notes: notes.length, duration: Math.max(...notes.map((note) => note.start + note.duration)) } } : {}) };
            await store.append!("attempt", { mode: "duet", prompt, notes, context, recognition: quality, assessment } as unknown as LocalJsonValue, attemptId);
            emit({ type: "attempt", id: attemptId, assessment });
            emit({ type: "heard", notes, transcription_ms: transcriptionMs, key });
            if (!notes.length || !key) { emit({ type: "done", notes: 0, total_ms: transcriptionMs }); return; }
            const shift = Math.max(-0.2, ...this.duetHistory.map((note) => note.start + note.duration)) + 0.2, first = notes[0].start;
            const played = notes.map((note) => ({ ...note, start: note.start - first + shift }));
            const preceding = [...this.duetHistory, ...played].slice(-180), origin = preceding[0].start;
            const promptNotes = preceding.map((note) => ({ ...note, start: note.start - origin }));
            const reply: ContextNote[] = [];
            let firstNoteMs: number | null = null;
            for await (const note of generator.generate({ notes: promptNotes, seconds, temperature, difficulty, tonic: key.tonic, pitchClasses: key.pitch_classes }, abort.signal)) {
              abort.signal.throwIfAborted();
              if (!key.pitch_classes.includes(note.pitch % 12)) throw new Error("Aria generated a note outside the constrained key");
              firstNoteMs ??= roundEven(performance.now() - started);
              reply.push(note); emit({ type: "note", note });
            }
            abort.signal.throwIfAborted();
            if (!reply.length) throw new Error("Aria returned no notes for the recognized piano phrase");
            const responseStart = Math.max(...promptNotes.map((note) => note.start + note.duration)) + 0.2;
            const history = [...promptNotes, ...reply.map((note) => ({ ...note, start: note.start + responseStart }))].slice(-180);
            const historyOrigin = history[0].start;
            this.duetHistory = history.map((note) => ({ ...note, start: note.start - historyOrigin }));
            emit({ type: "done", notes: reply.length, first_note_ms: firstNoteMs, transcription_ms: transcriptionMs,
              total_ms: roundEven(performance.now() - started) });
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
