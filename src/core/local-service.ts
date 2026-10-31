import { learnerProfile } from "./learner-profile.ts";
import { generatePracticeTask, practiceSequence } from "./practice-task.ts";
import type { GeneratedPracticeTask, PracticePiece } from "./practice-task.ts";
import { assessPractice } from "./practice-assessment.ts";
import type { PracticePrompt } from "./practice-assessment.ts";
import { choosePracticeFocus } from "./practice-selection.ts";
import type { SelectionProfile } from "./practice-selection.ts";
import { parseJsonBody, validateAid, validateExclusion, validateMidi, validatePathUuid, validatePiece,
  validatePracticeQuery, validatePracticeRequest } from "./practice-request.ts";
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
import type { KeyMode } from "./musical-key.ts";
import { roundDecimal, roundEven } from "./numeric.ts";
import { assessReading, matchesReading } from "./reading-assessment.ts";
import type { HeardNote } from "./reading-assessment.ts";
import { readingAttacks } from "./reading-score.ts";
import { scoreXp } from "./reading-rewards.ts";
import { measureLandings } from "./reading-fluency.ts";
import type { PositionChange } from "./reading-fluency.ts";
import { LIBRARY_CATALOG } from "./library-catalog.ts";
import { DRILL_CATALOG } from "./drill-catalog.ts";
import { drillProgress } from "./drill-progress.ts";
import type { DrillAttempt } from "./drill-progress.ts";
import { drillLevels } from "./drill-levels.ts";
import type { DrillId } from "./drill-levels.ts";
import { coachDrill, drillConfigKey } from "./drill-coach.ts";
import { buildDrillTask, validateDrill } from "./drill-task.ts";
import type { DrillSelection } from "./drill-task.ts";
import { assessDrill } from "./drill-assessment.ts";
import type { DrillNote } from "./drill-timing.ts";
import { KeyTracker } from "./key-tracker.ts";
import { buildSong, parseScore, performanceTempo } from "./score-build.ts";
import { ScoreError } from "./score-midi.ts";
import { editSong, revertSong, songAttacks, songStats, songSummary, songVersion } from "./library.ts";
import type { Song, SongNote } from "./library.ts";
import { libraryFromEvents } from "./library-events.ts";
import { practiceTasksFromEvents } from "./practice-task-events.ts";
import { exportMidi } from "./midi-export.ts";
import { DuetService } from "./duet-service.ts";
import type { LocalPhraseTranscriber, LocalDuetGenerator } from "./duet-service.ts";
export type { LocalPhraseTranscriber, LocalDuetGenerator } from "./duet-service.ts";
import { VariationService } from "./variation-service.ts";
import type { LocalVariationAnalyzer } from "./variation-service.ts";

export type LocalJsonValue = null | boolean | number | string | LocalJsonValue[] | { [key: string]: LocalJsonValue };
export interface LocalEventStore {
  list(): Promise<ReadingLogEvent[]>;
  append?(kind: "attempt" | "exclusion" | "song" | "edit" | "setting", payload: LocalJsonValue, eventId?: string): Promise<ReadingLogEvent>;
}
export interface LocalTranscriber {
  run(input: { audio: Float32Array; sampleRate: 16000; threshold: number }, signal?: AbortSignal): Promise<{ notes: unknown[] }>;
}
export interface LocalRecordingTranscriber {
  run(input: { audio: Float32Array; sampleRate: 16000 }, signal?: AbortSignal): Promise<{ notes: (DrillNote & { duration: number })[] }>;
}
export interface LocalRecordingImporter {
  run(data: ArrayBuffer, signal?: AbortSignal): Promise<{ musicXml: string; notes: { start: number }[] }>;
}
export interface LocalAssets { fetch(path: string, options?: RequestInit): Promise<Response> }
type ReadingTask = ReadingScore & { id: string; family: "reading"; purpose: string; shape: string; cue: string; even: boolean; dynamics: null;
  context: { notation_visible: boolean; hearings: number; reveals: number; hints: number; familiar: boolean; interaction?: string; introduction?: boolean } };
type PracticeTask = GeneratedPracticeTask | ReadingTask | ReturnType<typeof buildDrillTask>;

export class LocalService {
  private readingBusy = false;
  private responseBusy = false;
  private readonly store: LocalEventStore;
  private readonly transcriber?: LocalTranscriber;
  private readonly phraseTranscriber?: LocalPhraseTranscriber;
  private readonly now: () => number;
  private readonly assets?: LocalAssets;
  private readonly rng: ComposerRandom & FoundationRandom;
  private readonly phrase: PhraseFactory;
  private readonly recording?: LocalRecordingTranscriber;
  private readonly recordingImporter?: LocalRecordingImporter;
  private readonly duetService: DuetService;
  private readonly variationService: VariationService;
  private readonly tasks = new Map<string, { task: PracticeTask; completed: boolean }>();
  private taskLoading?: Promise<void>;
  private completionBusy = false;

  constructor(store: LocalEventStore, transcriber?: LocalTranscriber, now: () => number = () => Date.now() / 1000, assets?: LocalAssets,
    rng: ComposerRandom & FoundationRandom = new RandomSource(), phrase: PhraseFactory = () => { throw new Error("Aria is not available yet"); },
    recording?: LocalRecordingTranscriber, recordingImporter?: LocalRecordingImporter, phraseTranscriber?: LocalPhraseTranscriber,
    duetGenerator?: LocalDuetGenerator, variationAnalyzer?: LocalVariationAnalyzer) {
    this.store = store;
    this.transcriber = transcriber;
    this.phraseTranscriber = phraseTranscriber;
    this.now = now;
    this.assets = assets;
    this.rng = rng;
    this.phrase = phrase;
    this.recording = recording;
    this.recordingImporter = recordingImporter;
    this.duetService = new DuetService(store, phraseTranscriber, duetGenerator, () => this.responseBusy || this.readingBusy,
      (busy) => { this.responseBusy = busy; });
    this.variationService = new VariationService(store, phraseTranscriber, variationAnalyzer, () => this.responseBusy || this.readingBusy,
      (busy) => { this.responseBusy = busy; });
  }

  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    options.signal?.throwIfAborted();
    await this.loadTasks();
    const url = new URL(path, "http://piano.local");
    if (url.origin !== "http://piano.local") throw new Error("Local service requests must use a local path");
    const method = (options.method ?? "GET").toUpperCase();
    if (method === "POST" && url.pathname === "/api/respond" && url.searchParams.get("mode") === "practice") return this.respondPractice(url, options);
    if (url.pathname.startsWith("/samples/")) {
      if (!this.assets) return Response.json({ detail: "Piano samples are not available yet" }, { status: 501 });
      return this.assets.fetch(url.pathname, options);
    }
    if (method === "GET" && url.pathname === "/api/status") {
      return Response.json({ application: "piano-duet", development: false, ready: true, busy: this.readingBusy || this.responseBusy,
        model: "Aria · ONNX 4-bit", sample_rate: 16000 });
    }
    if (method === "GET" && url.pathname === "/api/profile") {
      return Response.json(learnerProfile(attemptsFromEvents(await this.store.list()), this.now()));
    }
    if (method === "POST" && url.pathname === "/api/export") {
      const body = parseJsonBody(options.body);
      if (body.errors.length) return Response.json({ detail: body.errors }, { status: 422 });
      const { value: notes, errors } = validateMidi(body.value);
      if (errors.length) return Response.json({ detail: errors }, { status: 422 });
      return new Response(exportMidi(notes).buffer as ArrayBuffer,
        { headers: { "Content-Type": "audio/midi", "Content-Disposition": 'attachment; filename="piano-duet.mid"' } });
    }
    if (method === "GET" && url.pathname === "/api/profile/export") {
      const events = await this.store.list();
      return Response.json({ format: 1, attempts: attemptsFromEvents(events), pieces: piecesFromEvents(events) },
        { headers: { "Content-Disposition": 'attachment; filename="piano-learning-history.json"' } });
    }
    if (method === "GET" && url.pathname === "/api/pieces") {
      return Response.json(piecesFromEvents(await this.store.list()));
    }
    if (method === "POST" && url.pathname === "/api/pieces") {
      const body = parseJsonBody(options.body);
      if (body.errors.length) return Response.json({ detail: body.errors }, { status: 422 });
      const { value: request, errors } = validatePiece(body.value);
      if (errors.length) return Response.json({ detail: errors }, { status: 422 });
      const title = request.title.trim();
      if (!title) return Response.json({ detail: "Give the piece a name" }, { status: 400 });
      const attempt = attemptsFromEvents(await this.store.list()).find((item) => item.id === request.attempt);
      if (!attempt || !attempt.notes.length) return Response.json({ detail: "No recognized performance to save" }, { status: 404 });
      if (!this.store.append) return Response.json({ detail: "Saving pieces is not available yet" }, { status: 501 });
      const notes = attempt.notes as { pitch: number; start: number; duration: number; velocity: number }[];
      const origin = Math.min(...notes.map((note) => note.start));
      const piece = { id: crypto.randomUUID(), title, challenge: 1, notes: notes.map((note) => ({ pitch: note.pitch,
        start: note.start - origin, duration: note.duration, velocity: note.velocity })),
        key: new KeyTracker().observe(notes), bpm: null };
      await this.store.append("song", { type: "piece", piece }, piece.id);
      return Response.json(piece);
    }
    if (method === "GET" && url.pathname === "/api/library") {
      const { songs, plays } = libraryFromEvents(await this.store.list());
      const summaries = await Promise.all([...songs.values()].sort((a, b) => a.created_at - b.created_at).map((song) => songSummary(song, plays.get(song.id) ?? [])));
      const imported = new Set(summaries.map((song) => song.title.toLowerCase()));
      return Response.json({ songs: summaries, catalog: LIBRARY_CATALOG.filter((item) => !imported.has(item.title.toLowerCase())) });
    }
    if (method === "POST" && url.pathname === "/api/library/import-audio") {
      const filename = url.searchParams.get("filename"), rights = url.searchParams.get("rights");
      if (!filename || filename.length > 200 || rights !== "1") return Response.json({ detail: "Confirm that you have the rights to transcribe this recording" }, { status: 400 });
      if (!(options.body instanceof ArrayBuffer) || !options.body.byteLength || options.body.byteLength > 256_000_000) {
        return Response.json({ detail: "Import an audio file under 256 MB" }, { status: 400 });
      }
      if (!this.recordingImporter || !this.store.append) return Response.json({ detail: "Recording import is not available" }, { status: 501 });
      const { musicXml, notes } = await this.recordingImporter.run(options.body, options.signal ?? undefined);
      const source = `${filename}.musicxml`;
      let draft;
      try {
        const parsed = parseScore(source, new TextEncoder().encode(musicXml));
        const title = filename.lastIndexOf(".") > 0 ? filename.slice(0, filename.lastIndexOf(".")) : filename;
        draft = buildSong({ ...parsed, bpm: performanceTempo(notes, parsed) }, title, null, source, true);
      }
      catch (error) {
        if (!(error instanceof ScoreError)) throw error;
        return Response.json({ detail: `Could not write ${filename}: ${error.message}` }, { status: 400 });
      }
      const id = crypto.randomUUID(), song = { id, ...draft };
      const event = await this.store.append("song", { action: "import", song } as unknown as LocalJsonValue, id);
      return Response.json(await songSummary({ ...song, created_at: Date.parse(event.createdAt) / 1000 }, []));
    }
    if (method === "POST" && url.pathname === "/api/library/import") {
      const filename = url.searchParams.get("filename"), title = url.searchParams.get("title"), artist = url.searchParams.get("artist");
      if (!filename || filename.length > 200 || (title?.length ?? 0) > 120 || (artist?.length ?? 0) > 120) return Response.json({ detail: "Invalid score details" }, { status: 422 });
      const body = options.body;
      if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return Response.json({ detail: "Import a score file under 8 MB" }, { status: 400 });
      const data = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      if (!data.length || data.length > 8_000_000) return Response.json({ detail: "Import a score file under 8 MB" }, { status: 400 });
      if (!this.store.append) return Response.json({ detail: "Saving songs is not available yet" }, { status: 501 });
      let draft;
      try { draft = buildSong(parseScore(filename, data), title, artist, filename); }
      catch (error) {
        if (!(error instanceof ScoreError)) throw error;
        return Response.json({ detail: `Could not import ${filename}: ${error.message}` }, { status: 400 });
      }
      const id = crypto.randomUUID(), song = { id, ...draft };
      const event = await this.store.append("song", { action: "import", song } as unknown as LocalJsonValue, id);
      return Response.json(await songSummary({ ...song, created_at: Date.parse(event.createdAt) / 1000 }, []));
    }
    if (method === "GET" && url.pathname === "/api/drills") {
      const attempts = attemptsFromEvents(await this.store.list());
      const { progress, streak_days } = drillProgress(attempts as unknown as DrillAttempt[], this.now());
      return Response.json({ catalog: DRILL_CATALOG, progress, levels: drillLevels(progress), streak_days });
    }
    if (method === "POST" && url.pathname === "/api/drills/next") {
      if (this.responseBusy) return Response.json({ detail: "Finish the current performance first" }, { status: 409 });
      if (typeof options.body !== "string") return Response.json({ detail: "A drill request needs JSON" }, { status: 400 });
      const request = JSON.parse(options.body) as Partial<DrillSelection> & { rung?: number | null; avoid?: DrillId[]; focus?: DrillId | null };
      const drills = Object.keys(DRILL_CATALOG.drills);
      if ((request.drill != null && !drills.includes(request.drill)) || (request.focus != null && !drills.includes(request.focus))
        || (request.avoid != null && (!Array.isArray(request.avoid) || request.avoid.some((drill) => !drills.includes(drill))))
        || (request.practice != null && !Object.hasOwn(DRILL_CATALOG.practices, request.practice))
        || (request.hands != null && !Object.hasOwn(DRILL_CATALOG.hands, request.hands))
        || (request.tonic != null && (!Number.isInteger(request.tonic) || request.tonic < 0 || request.tonic > 11))
        || (request.octaves != null && (!Number.isInteger(request.octaves) || request.octaves < 1 || request.octaves > 4))
        || (request.inversion != null && (!Number.isInteger(request.inversion) || request.inversion < 0 || request.inversion > 2))
        || (request.drill == null && (request.variant != null || request.tonic != null || request.hands != null || request.octaves != null || request.rung != null))
        || (request.drill != null && ((request.avoid?.length ?? 0) > 0 || request.focus != null || request.variant == null || request.tonic == null || request.hands == null || request.octaves == null))
        || (request.rung != null && (!Number.isInteger(request.rung) || request.rung < 0))) {
        return Response.json({ detail: "Invalid drill request" }, { status: 422 });
      }
      const attempts = attemptsFromEvents(await this.store.list());
      const { progress } = drillProgress(attempts as unknown as DrillAttempt[], this.now());
      const coached = request.drill == null ? coachDrill(progress, request.avoid ?? [], this.now(), request.focus ?? null) : null;
      const config: DrillSelection = coached?.config ?? { drill: request.drill!, variant: request.variant!, tonic: request.tonic!,
        hands: request.hands!, octaves: request.octaves!, inversion: request.inversion ?? 0, practice: request.practice ?? "even" };
      try { validateDrill(config); } catch (error) {
        if (!(error instanceof Error)) throw error;
        return Response.json({ detail: error.message }, { status: 400 });
      }
      const entry = progress[drillConfigKey(config)];
      const rung = request.rung ?? entry?.working ?? DRILL_CATALOG.drills[config.drill].start;
      if (rung >= DRILL_CATALOG.drills[config.drill].ladder.length) return Response.json({ detail: "That tempo is outside this drill's ladder" }, { status: 400 });
      try {
        const task = buildDrillTask(config, rung, entry ?? null);
        if (coached) { task.reason = `${coached.reason} ${task.reason}`; Object.assign(task.drill, { coach: coached.reason }); }
        this.tasks.set(task.id, { task, completed: false });
        return Response.json(task);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "This drill does not fit on the piano keyboard") throw error;
        return Response.json({ detail: error.message }, { status: 400 });
      }
    }
    if (method === "POST" && url.pathname === "/api/practice/next") {
      const body = parseJsonBody(options.body);
      if (body.errors.length) return Response.json({ detail: body.errors }, { status: 422 });
      const { value: request, errors } = validatePracticeRequest(body.value, READING_STAGES.length);
      if (errors.length) return Response.json({ detail: errors }, { status: 422 });
      if (this.responseBusy) return Response.json({ detail: "Finish the current performance first" }, { status: 409 });
      const focus = request.focus;
      if (request.step_by_step && focus !== "reading") return Response.json({ detail: "Step-by-step practice requires the reading focus" }, { status: 400 });
      if (request.after) {
        const preceding = this.tasks.get(request.after);
        if (!preceding) return Response.json({ detail: "Unknown preceding reading score" }, { status: 404 });
        if (!request.step_by_step || focus !== "reading" || preceding.task.family !== "reading" || preceding.task.context.interaction !== "step_by_step") {
          return Response.json({ detail: "A preview requires a preceding step-by-step reading score" }, { status: 400 });
        }
      }
      if (request.stage != null && focus !== "reading") return Response.json({ detail: "Only reading practice can replay a stage" }, { status: 400 });
      const events = await this.store.list(), attempts = attemptsFromEvents(events);
      if (!this.store.append) return Response.json({ detail: "Saving practice is not available yet" }, { status: 501 });
      const pieces = piecesFromEvents(events);
      if (request.piece && !pieces.some((piece) => piece.id === request.piece)) return Response.json({ detail: "Unknown practice piece" }, { status: 404 });
      const profile = learnerProfile(attempts, this.now());
      const [family, purpose] = focus === "guided" ? choosePracticeFocus(profile as unknown as SelectionProfile, this.now()) : [focus, "Explore"];
      if (family === "reading") return this.nextReading(request, attempts as unknown as ProgressAttempt[], !!request.step_by_step, purpose);
      if (family === "repertoire" && !pieces.length) {
        if (!this.store.append) return Response.json({ detail: "Saving pieces is not available yet" }, { status: 501 });
        const piece: PracticePiece = { id: crypto.randomUUID(), title: "First steps", key: musicalKey(0, "major"), challenge: 1,
          bpm: 60, notes: practiceSequence([60, 62, 64, 62, 60, 64, 62, 60], 60) };
        await this.store.append("song", { type: "piece", piece } as unknown as LocalJsonValue, piece.id);
        pieces.push(piece);
      }
      const task = generatePracticeTask(profile as unknown as Parameters<typeof generatePracticeTask>[0],
        focus as Parameters<typeof generatePracticeTask>[1], crypto.randomUUID(), this.rng, this.now(), pieces,
        attempts as unknown as Parameters<typeof generatePracticeTask>[6], request.piece);
      await this.saveTask(task);
      return Response.json(task);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "api" && parts[1] === "library" && parts.length >= 3 && parts.length <= 4) {
      return this.libraryRequest(method, parts, options);
    }
    if (parts[0] === "api" && parts[1] === "attempts" && parts.length >= 3 && parts.length <= 4) {
      const path = validatePathUuid(parts[2], "attempt_id");
      let excluded: boolean | undefined;
      if (method === "POST" && parts.length === 4 && parts[3] === "exclude") {
        const body = parseJsonBody(options.body);
        const result = body.errors.length ? { value: false, errors: body.errors } : validateExclusion(body.value);
        if (path.errors.length || result.errors.length) return Response.json({ detail: [...path.errors, ...result.errors] }, { status: 422 });
        excluded = result.value;
      }
      if (path.errors.length) return Response.json({ detail: path.errors }, { status: 422 });
      const attempts = attemptsFromEvents(await this.store.list());
      const attempt = attempts.find((item) => item.id === path.value);
      if (!attempt) return Response.json({ detail: "Unknown performance" }, { status: 404 });
      if (method === "GET" && parts.length === 3) {
        if (attempt.prompt.family !== "reading") return Response.json(attempt);
        const reading = attempt as unknown as ProgressAttempt;
        const fluency = measureLandings((reading.assessment.fluency ?? []) as PositionChange[], reading.assessment.observations, reading.context);
        return Response.json({ ...attempt, assessment: { ...attempt.assessment, fluency } });
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "exclude") {
        if (!this.store.append) return Response.json({ detail: "Saving practice is not available yet" }, { status: 501 });
        if (excluded === undefined) throw new Error("Missing validated exclusion");
        await this.store.append("exclusion", { attemptId: attempt.id, excluded });
        return Response.json(learnerProfile(attemptsFromEvents(await this.store.list()), this.now()));
      }
    }
    if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "practice" && parts[3] === "aid") {
      const path = validatePathUuid(parts[2], "task_id"), body = parseJsonBody(options.body);
      const result = body.errors.length ? { value: "hints" as const, errors: body.errors } : validateAid(body.value);
      if (path.errors.length || result.errors.length) return Response.json({ detail: [...path.errors, ...result.errors] }, { status: 422 });
      const kind = result.value;
      if (this.responseBusy) return Response.json({ detail: "Finish the current performance first" }, { status: 409 });
      const entry = this.tasks.get(path.value!);
      if (!entry || entry.completed) return Response.json({ detail: "Choose an unfinished exercise first" }, { status: 409 });
      const { task } = entry;
      if (!("drill" in task)) {
        if (!this.store.append) return Response.json({ detail: "Saving practice is not available yet" }, { status: 501 });
        await this.store.append("setting", { type: "practice-aid", taskId: task.id, kind });
      }
      task.context[kind]++;
      return Response.json(task);
    }
    if (method === "POST" && url.pathname === "/api/reading/listen") return this.listen(url, options);
    if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "reading" && parts[3] === "retry") {
      const path = validatePathUuid(parts[2], "task_id");
      if (path.errors.length) return Response.json({ detail: path.errors }, { status: 422 });
      const entry = this.tasks.get(path.value!);
      if (!entry || entry.task.family !== "reading" || !entry.completed) return Response.json({ detail: "Complete a reading score before trying again" }, { status: 409 });
      const task = structuredClone(entry.task);
      task.id = crypto.randomUUID();
      task.context.familiar = true;
      await this.saveTask(task);
      return Response.json(task);
    }
    if (method === "POST" && url.pathname === "/api/reading/complete") return this.completeReading(options);
    if (method === "POST" && url.pathname === "/api/respond" && url.searchParams.get("mode") === "drills") return this.respondDrill(url, options);
    if (method === "POST" && url.pathname === "/api/respond" && (url.searchParams.get("mode") ?? "duet") === "duet") return this.duetService.respond(url, options);
    if (method === "POST" && url.pathname === "/api/respond" && url.searchParams.get("mode") === "learning") return this.variationService.respond(url, options);
    return Response.json({ detail: `Local service does not yet implement ${method} ${url.pathname}` }, { status: 501 });
  }

  private async loadTasks(): Promise<void> {
    this.taskLoading ??= this.store.list().then((events) => {
      for (const [id, entry] of practiceTasksFromEvents<PracticeTask>(events)) this.tasks.set(id, entry);
    });
    await this.taskLoading;
  }

  private async saveTask(task: ReadingTask | GeneratedPracticeTask): Promise<void> {
    if (!this.store.append) throw new Error("Saving practice is not available");
    await this.store.append("setting", { type: "practice-task", task: structuredClone(task) } as unknown as LocalJsonValue);
    this.tasks.set(task.id, { task, completed: false });
  }

  private async libraryRequest(method: string, parts: string[], options: RequestInit): Promise<Response> {
    const id = parts[2];
    if (!validUuid(id)) return Response.json({ detail: "Invalid song ID" }, { status: 422 });
    const events = await this.store.list(), { songs, plays } = libraryFromEvents(events), song = songs.get(id);
    if (!song) return Response.json({ detail: "Unknown song" }, { status: 404 });
    const history = plays.get(id) ?? [];
    if (method === "GET" && parts.length === 3) return Response.json({ ...song, stats: await songStats(song, history) });
    if (!this.store.append) return Response.json({ detail: "Saving songs is not available yet" }, { status: 501 });
    if (method === "DELETE" && parts.length === 3) {
      await this.store.append("song", { action: "delete", songId: id });
      return Response.json({ deleted: id });
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "revert") {
      if (!song.original) return Response.json({ detail: "This song has not been edited" }, { status: 400 });
      const reverted = revertSong(song);
      await this.store.append("edit", { action: "song", songId: id, song: reverted } as unknown as LocalJsonValue);
      return Response.json({ ...reverted, stats: await songStats(reverted, history) });
    }
    if (typeof options.body !== "string") return Response.json({ detail: "A song request needs JSON" }, { status: 400 });
    let request: unknown;
    try { request = JSON.parse(options.body) as unknown; }
    catch (error) { if (error instanceof SyntaxError) return Response.json({ detail: "Invalid song request" }, { status: 422 }); throw error; }
    if (method === "PUT" && parts.length === 3) {
      if (!validSongEdit(request)) return Response.json({ detail: "Invalid song edit" }, { status: 422 });
      const notes = request.notes.map((note) => ({ pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity,
        staff: note.staff, voice: note.voice, grace: note.grace ?? false }));
      let edited: Song;
      try { edited = editSong(song, request.bpm, request.meter, request.tonic, request.mode, notes); }
      catch (error) {
        if (!(error instanceof Error) || !["A song needs at least one note", "Every note must start and end on the score's sixteenth or triplet grid", `${request.meter} time is not supported`].includes(error.message)) throw error;
        return Response.json({ detail: error.message }, { status: 400 });
      }
      await this.store.append("edit", { action: "song", songId: id, song: edited } as unknown as LocalJsonValue);
      return Response.json({ ...edited, stats: await songStats(edited, history) });
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "plays") {
      if (!validSongPlay(request)) return Response.json({ detail: "Invalid song play" }, { status: 422 });
      const indices = request.attacks.map(([index]) => index), total = songAttacks(song.notes).length;
      if (new Set(indices).size !== indices.length || indices.some((index) => index < 0 || index >= total)) {
        return Response.json({ detail: "Each played attack must be a distinct position in the song" }, { status: 400 });
      }
      if (events.some((event) => event.id === request.id)) return Response.json({ detail: "This play has already been saved" }, { status: 409 });
      const version = await songVersion(song.notes);
      const event = await this.store.append("song", { action: "play", songId: id, version, attacks: request.attacks }, request.id);
      return Response.json(await songStats(song, [...history, { created_at: Date.parse(event.createdAt) / 1000, version, attacks: request.attacks }]));
    }
    return Response.json({ detail: `Local service does not yet implement ${method} /${parts.join("/")}` }, { status: 501 });
  }

  private async nextReading(request: { stage?: number | null; after?: string | null }, attempts: ProgressAttempt[], stepByStep: boolean, selectedPurpose: string): Promise<Response> {
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
    const purpose = skill.accuracy !== null && skill.accuracy < 70 ? "Repair" : selectedPurpose;
    const past = [...attempts].reverse().find((item) => !item.excluded && item.context.source === "microphone"
      && (item as ProgressAttempt & { mode: string }).mode === "practice" && item.prompt.reading)?.prompt as unknown as FoundationCandidate | undefined;
    const seen = new Set([...this.tasks.values()].filter((entry) => entry.task.family === "reading").map((entry) => readingFingerprint(entry.task as ReadingTask)));
    for (const event of await this.store.list()) {
      if (event.kind !== "setting" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
      const payload = event.payload as { type?: unknown; task?: unknown };
      if (payload.type === "mac-task" && payload.task && typeof payload.task === "object" && (payload.task as { family?: unknown }).family === "reading") {
        seen.add(readingFingerprint(payload.task as ReadingTask));
      }
    }
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
        : await readingFoundation(progress, this.rng, this.phrase, (previous as FoundationCandidate | undefined) ?? past ?? null, variation, purpose === "Repair", stepByStep, context);
      if (!seen.has(readingFingerprint(candidate))) break;
      candidate = undefined;
    }
    if (!candidate) throw new Error("Could not generate an unseen reading exercise");
    const task: ReadingTask = { id: crypto.randomUUID(), family: "reading", meter: "4/4", key: musicalKey(0, "major"), purpose,
      ...candidate, shape: "melody", cue: "", even: false, dynamics: null,
      instruction: candidate.instruction + (stepByStep ? " There is no time limit; the score waits for the right note." : ""),
      context: { notation_visible: true, hearings: 0, reveals: 0, hints: 0, familiar: false,
        ...(stepByStep ? { interaction: "step_by_step", introduction: candidate.reading.introduce !== null } : {}) } };
    await this.saveTask(task);
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

  private async respondPractice(url: URL, options: RequestInit): Promise<Response> {
    const { value: request, errors } = validatePracticeQuery(url.searchParams);
    if (errors.length) return Response.json({ detail: errors }, { status: 422 });
    if (this.responseBusy || this.readingBusy) return Response.json({ detail: "The previous response is still finishing. Please retry." }, { status: 409 });
    const { session, task: taskId, attempt: attemptId, source, threshold } = request;
    if (url.searchParams.has("listening")) return Response.json({ detail: "Only drill takes carry what the live attack counter heard" }, { status: 400 });
    const entry = taskId ? this.tasks.get(taskId) : undefined;
    if (!entry || entry.completed) return Response.json({ detail: "Choose an unfinished exercise before playing" }, { status: 409 });
    if ("drill" in entry.task) return Response.json({ detail: "Drills are played in drill mode, and only drills are" }, { status: 400 });
    const task = entry.task;
    if (task.family === "ear" && !task.context.hearings) return Response.json({ detail: "Hear the melody before playing it back" }, { status: 400 });
    if (!this.phraseTranscriber) return Response.json({ detail: "Phrase transcription is not available yet" }, { status: 501 });
    if (!this.store.append) return Response.json({ detail: "Saving practice is not available yet" }, { status: 501 });
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
    if (this.responseBusy || this.readingBusy) return Response.json({ detail: "The previous response is still finishing. Please retry." }, { status: 409 });
    if (entry.completed) return Response.json({ detail: "This exercise was completed while the audio was being received" }, { status: 409 });
    this.responseBusy = true;
    const abort = new AbortController(), externalSignal = options.signal;
    const relay = () => abort.abort();
    externalSignal?.addEventListener("abort", relay, { once: true });
    if (externalSignal?.aborted) abort.abort();
    const transcriber = this.phraseTranscriber, store = this.store;
    const audioContext = { seconds: audio.length / 16000, peak, rms: roundDecimal(Math.sqrt(squares / audio.length), 6), note_threshold: threshold };
    const encoder = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const emit = (event: unknown) => { if (open) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
        const run = async () => {
          try {
            abort.signal.throwIfAborted();
            emit({ type: "transcribing", progress: 0 });
            const started = performance.now();
            const { notes, quality } = await transcriber.run({ audio, sampleRate: 16000, threshold }, abort.signal);
            const transcriptionMs = roundEven(performance.now() - started);
            abort.signal.throwIfAborted();
            emit({ type: "transcribing", progress: 1 });
            const context = { ...task.context, source, family: task.family, audio: audioContext, session,
              estimated_key: notes.length ? new KeyTracker().observe(notes) : null };
            const assessment = assessPractice(task as PracticePrompt, notes, context, quality);
            const payload = { mode: "practice", prompt: { ...task, completed: false }, notes, context, recognition: quality, assessment };
            await store.append!("attempt", payload as unknown as LocalJsonValue, attemptId);
            if (notes.length) entry.completed = true;
            emit({ type: "attempt", id: attemptId, assessment });
            emit({ type: "heard", notes, key: task.key, transcription_ms: transcriptionMs });
            emit({ type: "assessment", id: attemptId, assessment });
            emit({ type: "done", notes: 0, stage: notes.length ? "complete" : "practice", empty: !notes.length });
          } catch (error) {
            if (!abort.signal.aborted) emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
          } finally {
            this.responseBusy = false;
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

  private async respondDrill(url: URL, options: RequestInit): Promise<Response> {
    if (this.responseBusy || this.readingBusy) return Response.json({ detail: "The previous response is still finishing. Please retry." }, { status: 409 });
    const session = url.searchParams.get("session"), taskId = url.searchParams.get("task"), suppliedAttempt = url.searchParams.get("attempt");
    const attemptId = suppliedAttempt ?? crypto.randomUUID(), source = url.searchParams.get("source") ?? "microphone";
    const threshold = Number(url.searchParams.get("threshold") ?? 0.8);
    if (!validUuid(session) || !validUuid(taskId) || !validUuid(attemptId) || !["microphone", "demo"].includes(source)
      || !Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.99) return Response.json({ detail: "Invalid drill performance request" }, { status: 422 });
    const entry = this.tasks.get(taskId!);
    if (!entry || entry.completed) return Response.json({ detail: "Choose an unfinished exercise before playing" }, { status: 409 });
    if (!("drill" in entry.task)) return Response.json({ detail: "Drills are played in drill mode, and only drills are" }, { status: 400 });
    if (!this.recording) return Response.json({ detail: "Recording transcription is not available yet" }, { status: 501 });
    if (!this.store.append) return Response.json({ detail: "Saving practice is not available yet" }, { status: 501 });
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
    const listeningValue = url.searchParams.get("listening");
    let listening: unknown;
    if (listeningValue !== null) {
      if (listeningValue.length > 20000) return Response.json({ detail: "Invalid listening summary" }, { status: 422 });
      listening = JSON.parse(listeningValue) as unknown;
      if (!validListening(listening)) return Response.json({ detail: "Invalid listening summary" }, { status: 422 });
    }
    if (peak > 1) for (let index = 0; index < audio.length; index++) audio[index] /= peak;
    const events = await this.store.list();
    if (events.some((event) => event.id === attemptId)) return Response.json({ detail: "This performance has already been saved" }, { status: 409 });
    if (this.responseBusy || this.readingBusy) return Response.json({ detail: "The previous response is still finishing. Please retry." }, { status: 409 });
    this.responseBusy = true;
    const abort = new AbortController(), externalSignal = options.signal;
    const relay = () => abort.abort();
    externalSignal?.addEventListener("abort", relay, { once: true });
    if (externalSignal?.aborted) abort.abort();
    const recording = this.recording, store = this.store, task = entry.task;
    const audioContext = { seconds: audio.length / 16000, peak, rms: roundDecimal(Math.sqrt(squares / audio.length), 6), note_threshold: threshold,
      ...(listening ? { listening } : {}) };
    const quality = { usable: true, model: "Transkun 2.0", reason: "Transkun 2.0 reports no onset confidence; check the heard notes if a take looks wrong" };
    const encoder = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const emit = (event: unknown) => { if (open) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
        const run = async () => {
          try {
            abort.signal.throwIfAborted();
            emit({ type: "transcribing", progress: 0 });
            const started = performance.now();
            const { notes } = await recording.run({ audio, sampleRate: 16000 }, abort.signal);
            const transcriptionMs = roundEven(performance.now() - started);
            abort.signal.throwIfAborted();
            emit({ type: "transcribing", progress: 1 });
            const context = { ...task.context, source, family: task.family, audio: audioContext, session,
              estimated_key: notes.length ? new KeyTracker().observe(notes) : null };
            const assessment = assessDrill(task, notes, context, quality);
            const payload = { mode: "drills", prompt: { ...task, completed: false }, notes, context, recognition: quality, assessment };
            await store.append!("attempt", payload as unknown as LocalJsonValue, attemptId);
            if (notes.length) entry.completed = true;
            emit({ type: "attempt", id: attemptId, assessment });
            emit({ type: "heard", notes, key: task.key, transcription_ms: transcriptionMs });
            emit({ type: "assessment", id: attemptId, assessment });
            emit({ type: "done", notes: 0, stage: notes.length ? "complete" : "practice", empty: !notes.length });
          } catch (error) {
            if (!abort.signal.aborted) emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
          } finally {
            this.responseBusy = false;
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

  private async listen(url: URL, options: RequestInit): Promise<Response> {
    const threshold = url.searchParams.has("threshold") ? Number(url.searchParams.get("threshold")) : 0.8;
    if (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.99) return Response.json({ detail: "Invalid note threshold" }, { status: 422 });
    if (this.readingBusy || this.responseBusy) return Response.json({ detail: "The piano is processing another performance" }, { status: 409 });
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
  return JSON.stringify([task.reading?.introduce != null, notes.map((note) => [note.pitch, roundDecimal((note.start - notes[0].start) / beat, 3), roundDecimal(note.duration / beat, 3)])]);
}

function validReadingRequest(request: { task: string; attempt: string; groups: HeardNote[][]; interruptions: number[]; threshold: number }): boolean {
  if (!validUuid(request.task) || !validUuid(request.attempt) || !Array.isArray(request.groups) || !request.groups.length || !Array.isArray(request.interruptions)
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

function validUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && value.split("-").map((part) => part.length).join(",") === "8,4,4,4,12"
    && [...value.replaceAll("-", "")].every((character) => "0123456789abcdefABCDEF".includes(character));
}

function validListening(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return typeof data.ended === "string" && ["attacks", "quiet", "limit", "space"].includes(data.ended)
    && [data.floor, data.noise, data.seconds].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
    && [data.attacks, data.strengths].every((items) => Array.isArray(items) && items.length <= 600
      && items.every((item) => typeof item === "number" && Number.isFinite(item)));
}

function validSongEdit(value: unknown): value is { bpm: number; meter: string; tonic: number; mode: KeyMode; notes: SongNote[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (!Number.isInteger(data.bpm) || (data.bpm as number) < 30 || (data.bpm as number) > 240 || typeof data.meter !== "string"
    || !Number.isInteger(data.tonic) || (data.tonic as number) < 0 || (data.tonic as number) > 11 || !["major", "minor"].includes(data.mode as string)
    || !Array.isArray(data.notes) || !data.notes.length) return false;
  return data.notes.every((note) => note && typeof note === "object" && Number.isInteger(note.pitch) && note.pitch >= 21 && note.pitch <= 108
    && Number.isFinite(note.start) && note.start >= 0 && Number.isFinite(note.duration) && note.duration > 0
    && Number.isInteger(note.velocity) && note.velocity >= 1 && note.velocity <= 127 && ["treble", "bass"].includes(note.staff)
    && (note.voice === 0 || note.voice === 1) && (note.grace === undefined || typeof note.grace === "boolean"));
}

function validSongPlay(value: unknown): value is { id: string; attacks: [number, boolean][] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return validUuid(data.id) && Array.isArray(data.attacks) && data.attacks.length > 0
    && data.attacks.every((row) => Array.isArray(row) && row.length === 2 && Number.isInteger(row[0]) && typeof row[1] === "boolean");
}

function isPiece(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "piece" && "piece" in value;
}

function piecesFromEvents(events: ReadingLogEvent[]): PracticePiece[] {
  return events.filter((event) => event.kind === "song" && isPiece(event.payload)).map((event) => (event.payload as { piece: PracticePiece }).piece);
}
