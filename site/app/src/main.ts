import VexFlow from "vexflow";
import "../../../src/piano_duet/static/style.css";
import "../../../src/piano_duet/static/score.css";
import "../../../src/piano_duet/static/practice.css";
import "../../../src/piano_duet/static/game.css";
import { setLocalService } from "../../../src/piano_duet/static/practice.mjs";
import { LocalService } from "../../../src/core/local-service.ts";
import { BrowserInference } from "./browser-inference";
import type { DownloadProgress, InferenceSession } from "./inference";
import { EventLog, requestPersistentStorage } from "./event-log";
import { PIANO_SAMPLES } from "./piano-samples";
import { SampleStore } from "./sample-store";
import "./style.css";

Object.assign(window, { VexFlow });
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
  const backend = new BrowserInference({});
  let live: Promise<InferenceSession<"live-transcription">> | undefined;
  const transcriber = {
    async run(input: { audio: Float32Array; sampleRate: 16000; threshold: number }, signal?: AbortSignal) {
      live ??= backend.createSession("live-transcription", report, signal).catch((error) => { live = undefined; throw error; });
      const session = await live;
      indicator.hidden = true;
      try { return await session.run(input, signal); }
      catch (error) { if (signal?.aborted) live = undefined; throw error; }
    },
  };
  setLocalService(new LocalService(log, transcriber, undefined, new SampleStore(report)));
  if (import.meta.env.PROD && "serviceWorker" in navigator) await navigator.serviceWorker.register("/service-worker.js");
  await import("../../../src/piano_duet/static/app.mjs");
}

start().catch((error: unknown) => {
  const display = document.querySelector<HTMLElement>("#error");
  if (!display) throw new Error("The interface has no error display");
  display.textContent = error instanceof Error ? error.message : String(error);
  display.hidden = false;
  throw error;
});
