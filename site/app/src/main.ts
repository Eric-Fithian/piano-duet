import VexFlow from "vexflow";
import "../../../src/piano_duet/static/style.css";
import "../../../src/piano_duet/static/score.css";
import "../../../src/piano_duet/static/practice.css";
import "../../../src/piano_duet/static/game.css";
import { setLocalService } from "../../../src/piano_duet/static/practice.mjs";
import { LocalService } from "../../../src/core/local-service.ts";
import { AriaPhrase } from "../../../src/core/aria-phrase.ts";
import { generateDuet } from "../../../src/core/duet-decoder.ts";
import { analyzeVariation } from "../../../src/core/variation-analysis.ts";
import type { VariationDetail } from "../../../src/core/variation-analysis.ts";
import type { ContextNote } from "../../../src/core/aria-tokenizer.ts";
import type { PhraseContext } from "../../../src/core/aria-tokenizer.ts";
import { RandomSource } from "../../../src/core/random.ts";
import { BrowserInference } from "./browser-inference";
import { NativeInference } from "./native-inference";
import { WebKitInferenceTransport } from "./webkit-inference-transport";
import type { WebKitMessageHandler } from "./webkit-inference-transport";
import { MODEL_CATALOG } from "./model-catalog";
import { describeInferenceBackend } from "./inference";
import type { DownloadProgress, InferenceBackendRecord, InferenceSession, ModelId } from "./inference";
import { EventLog, requestPersistentStorage } from "./event-log";
import { PIANO_SAMPLES } from "./piano-samples";
import { SampleStore } from "./sample-store";
import { BrowserRecordingImporter } from "./browser-recording-import";
import { NativeRecordingImporter } from "./native-recording-import";
import { recordingStage, setupRecordingUi } from "./recording-ui";
import { setupHistoryImport } from "./history-import";
import "./style.css";

Object.assign(window, { VexFlow });
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as { type?: string; error?: string } | null;
  if (message?.type !== "offline-install-error") return;
  const display = document.querySelector<HTMLElement>("#error");
  if (!display) throw new Error("The interface has no error display");
  display.textContent = `Offline setup failed: ${message.error}. Check available device storage and reload.`;
  display.hidden = false;
  console.error(display.textContent);
});
const indicator = document.createElement("section");
indicator.className = "asset-download";
indicator.setAttribute("aria-live", "polite");
indicator.hidden = true;
const label = document.createElement("span");
const bar = document.createElement("progress");
indicator.append(label, bar);
document.body.append(indicator);
const received = new Map<string, number>();
const sampleBytes = PIANO_SAMPLES.reduce((sum, sample) => sum + sample.bytes, 0);
function report(progress: DownloadProgress): void {
  indicator.hidden = false;
  if (progress.model === "piano-samples") {
    received.set(progress.file, progress.received);
    bar.max = sampleBytes;
    bar.value = [...received.values()].reduce((sum, value) => sum + value, 0);
    label.textContent = "Preparing piano sounds";
    if (bar.value === bar.max) indicator.hidden = true;
  } else {
    label.textContent = `Preparing ${progress.file}`;
    if (progress.total === null) bar.removeAttribute("value");
    else { bar.max = progress.total; bar.value = progress.received; }
  }
}

async function start(): Promise<void> {
  const log = new EventLog();
  await requestPersistentStorage();
  await log.open();
  const native = (window as Window & { webkit?: { messageHandlers?: { pianoInference?: WebKitMessageHandler } } }).webkit?.messageHandlers?.pianoInference;
  const backend = native ? new NativeInference(new WebKitInferenceTransport(native, window)) : new BrowserInference(MODEL_CATALOG);
  const settings = document.querySelector<HTMLElement>("#settingsDialog");
  if (!settings) throw new Error("The settings dialog is missing");
  const backendStatus = document.createElement("p"), backends = new Map<ModelId, string>();
  backendStatus.setAttribute("aria-live", "polite");
  settings.append(backendStatus);
  const reportBackend = (model: ModelId, record: InferenceBackendRecord) => {
    backends.set(model, describeInferenceBackend({ model, provider: record.provider, fallback: record.fallback }));
    backendStatus.textContent = `Model backends: ${[...backends.values()].join("; ")}`;
  };
  const openSession = async <K extends ModelId>(model: K, signal?: AbortSignal): Promise<InferenceSession<K>> => {
    const session = await backend.createSession(model, report, signal);
    reportBackend(model, session);
    return session;
  };
  let live: Promise<InferenceSession<"live-transcription">> | undefined;
  const transcriber = {
    async run(input: { audio: Float32Array; sampleRate: 16000; threshold: number }, signal?: AbortSignal) {
      live ??= openSession("live-transcription", signal).catch((error) => { live = undefined; throw error; });
      const session = await live;
      indicator.hidden = true;
      try { return await session.run(input, signal); }
      catch (error) { if (signal?.aborted) live = undefined; throw error; }
    },
  };
  let recording: Promise<InferenceSession<"recording-transcription">> | undefined;
  const recordingTranscriber = {
    async run(input: { audio: Float32Array; sampleRate: 16000 }, signal?: AbortSignal) {
      recording ??= openSession("recording-transcription", signal).catch((error) => { recording = undefined; throw error; });
      const session = await recording;
      indicator.hidden = true;
      try { return await session.run(input, signal); }
      catch (error) { if (signal?.aborted) recording = undefined; throw error; }
    },
  };
  const random = new RandomSource();
  let aria: Promise<InferenceSession<"aria">> | undefined;
  const openAria = async (signal?: AbortSignal) => {
    aria ??= openSession("aria", signal).catch((error) => { aria = undefined; throw error; });
    const session = await aria;
    indicator.hidden = true;
    return session;
  };
  const phrase = async (context: unknown) => {
    const session = await openAria();
    return new AriaPhrase(session, random, context as PhraseContext | null);
  };
  let phraseSession: Promise<InferenceSession<"phrase-transcription">> | undefined;
  const phraseTranscriber = {
    async run(input: { audio: Float32Array; sampleRate: 16000; threshold: number }, signal?: AbortSignal) {
      phraseSession ??= openSession("phrase-transcription", signal).catch((error) => { phraseSession = undefined; throw error; });
      const session = await phraseSession;
      indicator.hidden = true;
      try { return await session.run(input, signal); }
      catch (error) { if (signal?.aborted) phraseSession = undefined; throw error; }
    },
  };
  const duetGenerator = {
    async *generate(input: { notes: ContextNote[]; seconds: number; temperature: number; difficulty: number; tonic: number; pitchClasses: number[] }, signal?: AbortSignal) {
      const session = await openAria(signal);
      try { yield* generateDuet(session, random, input.notes, { ...input, signal }); }
      finally { if (signal?.aborted) aria = undefined; }
    },
  };
  const variationAnalyzer = {
    async run(notes: ContextNote[], threshold: number, signal?: AbortSignal, onNote?: (detail: VariationDetail, progress: number) => void) {
      const session = await openAria(signal);
      try { return await analyzeVariation(session, notes, threshold, signal, onNote); }
      catch (error) { if (signal?.aborted) aria = undefined; throw error; }
    },
  };
  const recordingAssets = MODEL_CATALOG["recording-transcription"], scoreAssets = MODEL_CATALOG["midi-to-score"];
  if (!recordingAssets || !scoreAssets) throw new Error("Recording import models are missing from the catalog");
  const importStage = (stage: string) => {
    indicator.hidden = true; recordingStage(stage);
  };
  const importer = native ? new NativeRecordingImporter(backend, report, importStage)
    : new BrowserRecordingImporter(recordingAssets, scoreAssets, report, importStage, (record) => reportBackend("midi-to-score", record));
  setLocalService(new LocalService(log, transcriber, undefined, new SampleStore(report), random, phrase, recordingTranscriber, importer,
    phraseTranscriber, duetGenerator, variationAnalyzer));
  if (import.meta.env.PROD && "serviceWorker" in navigator) await navigator.serviceWorker.register("/service-worker.js");
  const app = await import("../../../src/piano_duet/static/app.mjs");
  setupRecordingUi(importer, app.loadLibrary);
  setupHistoryImport(log, async () => { await app.refreshProfile(); await app.loadLibrary(); });
}

start().catch((error: unknown) => {
  const display = document.querySelector<HTMLElement>("#error");
  if (!display) throw new Error("The interface has no error display");
  display.textContent = error instanceof Error ? error.message : String(error);
  display.hidden = false;
  throw error;
});
