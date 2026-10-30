import { learnerProfile } from "./learner-profile.ts";
import { initialPracticeTask } from "./initial-practice.ts";
import { attemptsFromEvents } from "./reading-events.ts";
import type { ReadingLogEvent } from "./reading-events.ts";
import { readingProgress } from "./reading-progress.ts";
import type { ProgressAttempt } from "./reading-progress.ts";
import { curriculumProgress } from "./reading-curriculum.ts";
import { readingFoundation } from "./reading-foundations.ts";
import type { FoundationCandidate, FoundationRandom } from "./reading-foundations.ts";
import { composeReading } from "./reading-composer.ts";
import type { ComposerRandom, PhraseFactory, ReadingScore } from "./reading-composer.ts";
import { READING_STAGES } from "./reading-stages.ts";
import { RandomSource } from "./random.ts";
import { musicalKey } from "./musical-key.ts";
import { roundDecimal } from "./numeric.ts";
import { assessReading, matchesReading } from "./reading-assessment.ts";
import type { HeardNote } from "./reading-assessment.ts";
import { readingAttacks } from "./reading-score.ts";
import { scoreXp } from "./reading-rewards.ts";

export type LocalJsonValue = null | boolean | number | string | LocalJsonValue[] | { [key: string]: LocalJsonValue };
export interface LocalEventStore {
  list(): Promise<ReadingLogEvent[]>;
  append?(kind: "attempt" | "exclusion", payload: LocalJsonValue, eventId?: string): Promise<ReadingLogEvent>;
}
export interface LocalTranscriber {
  run(input: { audio: Float32Array; sampleRate: 16000; threshold: number }, signal?: AbortSignal): Promise<{ notes: unknown[] }>;
}
export interface LocalAssets { fetch(path: string, options?: RequestInit): Promise<Response> }
type ReadingTask = ReadingScore & { id: string; family: "reading"; purpose: string; shape: string; cue: string; even: boolean; dynamics: null;
  context: { notation_visible: boolean; hearings: number; reveals: number; hints: number; familiar: boolean; interaction: string; introduction: boolean } };
type PracticeTask = ReturnType<typeof initialPracticeTask> | ReadingTask;

export class LocalService {
  private readingBusy = false;
  private readonly store: LocalEventStore;
  private readonly transcriber?: LocalTranscriber;
  private readonly now: () => number;
  private readonly assets?: LocalAssets;
  private readonly rng: ComposerRandom & FoundationRandom;
  private readonly phrase: PhraseFactory;
  private readonly tasks = new Map<string, { task: PracticeTask; completed: boolean }>();
  private completionBusy = false;

  constructor(store: LocalEventStore, transcriber?: LocalTranscriber, now: () => number = () => Date.now() / 1000, assets?: LocalAssets,
    rng: ComposerRandom & FoundationRandom = new RandomSource(), phrase: PhraseFactory = () => { throw new Error("Aria is not available yet"); }) {
    this.store = store;
    this.transcriber = transcriber;
    this.now = now;
    this.assets = assets;
    this.rng = rng;
    this.phrase = phrase;
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
      if (focus === "reading" && request.step_by_step) return this.nextReading(request, attempts as unknown as ProgressAttempt[]);
      if ((focus === "guided" || focus === "technique") && !attempts.length && !request.piece && !request.stage && !request.after) {
        const task = initialPracticeTask(crypto.randomUUID(), focus);
        this.tasks.set(task.id, { task, completed: false });
        return Response.json(task);
      }
      return Response.json({ detail: "This practice selection is not available yet" }, { status: 501 });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "practice" && parts[3] === "aid") {
      const entry = this.tasks.get(parts[2]);
      if (!entry || entry.completed) return Response.json({ detail: "Choose an unfinished exercise first" }, { status: 409 });
      const { task } = entry;
      if (typeof options.body !== "string") return Response.json({ detail: "An aid request needs JSON" }, { status: 400 });
      const request = JSON.parse(options.body) as { kind?: "hearings" | "reveals" | "hints" };
      if (request.kind !== "hearings" && request.kind !== "reveals" && request.kind !== "hints") return Response.json({ detail: "Invalid aid" }, { status: 422 });
      task.context[request.kind]++;
      return Response.json(task);
    }
    if (method === "POST" && url.pathname === "/api/reading/listen") return this.listen(url, options);
    if (method === "POST" && url.pathname === "/api/reading/complete") return this.completeReading(options);
    return Response.json({ detail: `Local service does not yet implement ${method} ${url.pathname}` }, { status: 501 });
  }

  private async nextReading(request: { stage?: number | null; after?: string | null }, attempts: ProgressAttempt[]): Promise<Response> {
    const progress = readingProgress(attempts);
    if (request.stage != null) {
      if (!Number.isInteger(request.stage) || request.stage < 1 || request.stage > READING_STAGES.length) return Response.json({ detail: "Invalid reading stage" }, { status: 422 });
      if (progress.curriculum.path[request.stage - 1].status === "Ahead") return Response.json({ detail: `Stage ${request.stage} is still locked` }, { status: 409 });
      progress.curriculum = curriculumProgress(attempts, request.stage);
    }
    const preceding = request.after ? this.tasks.get(request.after)?.task : undefined;
    if (request.after && (!preceding || preceding.family !== "reading" || preceding.context.interaction !== "step_by_step")) {
      return Response.json({ detail: "A preview requires a preceding step-by-step reading score" }, { status: 400 });
    }
    const previous = preceding?.family === "reading" ? preceding : undefined;
    if (previous && previous.reading.stage_id === progress.curriculum.target) {
      progress.curriculum.recent_rhythms.push(previous.target.map((note) => [roundDecimal(note.start * previous.bpm / 60, 4), roundDecimal(note.duration * previous.bpm / 60, 4)]));
    }
    if (previous?.reading.introduce != null) progress.hands[previous.reading.clef].introduced.push(previous.reading.introduce);
    const profile = learnerProfile(attempts as unknown as Parameters<typeof learnerProfile>[0], this.now());
    const skill = profile.skills.find((item) => item.id === "reading.pitch");
    if (!skill) throw new Error("The profile has no reading skill");
    const purpose = skill.accuracy !== null && skill.accuracy < 70 ? "Repair" : "Explore";
    const past = [...attempts].reverse().find((item) => !item.excluded && item.context.source === "microphone"
      && (item as ProgressAttempt & { mode: string }).mode === "practice" && item.prompt.reading)?.prompt as unknown as FoundationCandidate | undefined;
    const seen = new Set([...this.tasks.values()].filter((entry) => entry.task.family === "reading").map((entry) => readingFingerprint(entry.task as ReadingTask)));
    for (const attempt of attempts) if (attempt.prompt.family === "reading") seen.add(readingFingerprint(attempt.prompt as unknown as ReadingScore));
    let context: { notes: ReadingScore["target"]; end: number } | null = null;
    if (previous) {
      const [numerator, denominator] = previous.meter.split("/").map(Number);
      context = { notes: previous.target, end: previous.reading.bars * numerator * 4 / denominator * 60 / previous.bpm };
    }
    let candidate: FoundationCandidate | ReadingScore | undefined;
    for (let variation = 0; variation < 200; variation++) {
      candidate = progress.curriculum.target_number >= 3
        ? await composeReading(READING_STAGES[progress.curriculum.target_number - 1], progress, this.rng, this.phrase, context)
        : await readingFoundation(progress, this.rng, this.phrase, (previous as FoundationCandidate | undefined) ?? past ?? null, variation, purpose === "Repair", true, context);
      if (!seen.has(readingFingerprint(candidate))) break;
      candidate = undefined;
    }
    if (!candidate) throw new Error("Could not generate an unseen reading exercise");
    const task: ReadingTask = { id: crypto.randomUUID(), family: "reading", meter: "4/4", key: musicalKey(0, "major"), purpose,
      ...candidate, shape: "melody", cue: "", even: false, dynamics: null,
      instruction: `${candidate.instruction} There is no time limit; the score waits for the right note.`,
      context: { notation_visible: true, hearings: 0, reveals: 0, hints: 0, familiar: false, interaction: "step_by_step", introduction: candidate.reading.introduce !== null } };
    this.tasks.set(task.id, { task, completed: false });
    return Response.json(task);
  }

  private async completeReading(options: RequestInit): Promise<Response> {
    if (this.completionBusy) return Response.json({ detail: "The piano is processing another performance" }, { status: 409 });
    if (typeof options.body !== "string") return Response.json({ detail: "A reading needs JSON" }, { status: 400 });
    const request = JSON.parse(options.body) as { task: string; attempt: string; groups: HeardNote[][]; interruptions: number[]; threshold: number };
    const entry = this.tasks.get(request.task);
    if (!entry || entry.completed || entry.task.family !== "reading") return Response.json({ detail: "Choose an unfinished reading score" }, { status: 409 });
    if (!this.store.append) return Response.json({ detail: "Saving practice is not available yet" }, { status: 501 });
    if (!validReadingRequest(request)) return Response.json({ detail: "Invalid reading" }, { status: 422 });
    this.completionBusy = true;
    try {
      if ((await this.store.list()).some((event) => event.id === request.attempt)) return Response.json({ detail: "This reading has already been saved" }, { status: 409 });
      const task = entry.task, attacks = readingAttacks(task.target);
      let cursor = 0;
      for (const group of request.groups) {
        if (cursor >= attacks.length) return Response.json({ detail: "The reading contains notes after the score was completed" }, { status: 400 });
        if (matchesReading(group.map((note) => note.pitch), attacks[cursor].indices.map((index) => task.target[index].pitch))) cursor++;
      }
      if (cursor !== attacks.length) return Response.json({ detail: "Finish every note in the score before saving the reading" }, { status: 400 });
      const context = { ...task.context, family: "reading", source: "microphone", interaction: "step_by_step", note_threshold: request.threshold,
        reading_timing: { interruptions: request.interruptions } };
      const { assessment, notes } = assessReading(task, request.groups, context);
      const payload = { mode: "practice", prompt: { ...task, completed: false }, context, notes, reading_attacks: request.groups, assessment };
      await this.store.append("attempt", payload as unknown as LocalJsonValue, request.attempt);
      entry.completed = true;
      return Response.json({ id: request.attempt, assessment, xp: scoreXp(task, assessment, context) });
    } finally { this.completionBusy = false; }
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

function readingFingerprint(task: Pick<ReadingScore, "target" | "reading"> | FoundationCandidate): string {
  const notes = task.target, starts = [...new Set(notes.map((note) => note.start))].sort((a, b) => a - b);
  const beat = starts.length > 1 ? Math.min(...starts.slice(1).map((start, index) => start - starts[index])) : 1;
  return JSON.stringify([task.reading.introduce != null, notes.map((note) => [note.pitch, roundDecimal((note.start - notes[0].start) / beat, 3), roundDecimal(note.duration / beat, 3)])]);
}

function validReadingRequest(request: { task: string; attempt: string; groups: HeardNote[][]; interruptions: number[]; threshold: number }): boolean {
  const uuid = (value: unknown) => typeof value === "string" && value.length === 36 && value.split("-").map((part) => part.length).join(",") === "8,4,4,4,12" && [...value.replaceAll("-", "")].every((character) => "0123456789abcdefABCDEF".includes(character));
  if (!uuid(request.task) || !uuid(request.attempt) || !Array.isArray(request.groups) || !request.groups.length || !Array.isArray(request.interruptions)
      || !Number.isFinite(request.threshold) || request.threshold < 0.1 || request.threshold > 0.99) return false;
  if (request.interruptions.some((value, index) => !Number.isInteger(value) || value < 0 || value > request.groups.length || (index > 0 && value <= request.interruptions[index - 1]))) return false;
  let previous = -1;
  for (const group of request.groups) {
    if (!Array.isArray(group) || !group.length || group.some((note) => !note || !Number.isInteger(note.pitch) || note.pitch < 21 || note.pitch > 108
      || !Number.isFinite(note.start) || note.start < 0 || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127
      || !Number.isFinite(note.confidence) || note.confidence < 0.1 || note.confidence > 1)) return false;
    const start = Math.min(...group.map((note) => note.start));
    if (start < previous) return false;
    previous = start;
  }
  return true;
}

function isPiece(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "piece" && "piece" in value;
}
