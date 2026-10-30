import { EventLog, requestPersistentStorage } from "./event-log";
import type { DownloadProgress } from "./inference";
import "./style.css";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Piano Duet needs an app container");

root.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Piano Duet home"><span class="brand-mark">♪</span><span>Piano Duet</span></a>
      <a class="guide" href="/docs/">Guide <span aria-hidden="true">↗</span></a>
    </header>
    <main>
      <p class="eyebrow">YOUR PIANO PRACTICE</p>
      <h1>Make a little<br><em>music every day.</em></h1>
      <p class="intro">Play at your own pace, with music and feedback that stay on your device.</p>
      <div class="modes" aria-label="Practice modes">
        <button disabled><span>01</span><strong>Reading</strong><small>Find your way around the score</small></button>
        <button disabled><span>02</span><strong>Drills</strong><small>Build your technique</small></button>
        <button disabled><span>03</span><strong>Duet</strong><small>Play a musical conversation</small></button>
        <button disabled><span>04</span><strong>Library</strong><small>Bring your own music</small></button>
      </div>
      <section class="notice" aria-live="polite">
        <span class="status-dot"></span>
        <div><strong id="storage-status">Preparing your practice space…</strong><p id="storage-detail">Your progress is stored on this device.</p></div>
      </section>
      <section id="download" class="download" hidden aria-live="polite">
        <label for="download-progress" id="download-label">Preparing your piano models</label>
        <progress id="download-progress"></progress>
      </section>
    </main>
    <footer><span>Made for the joy of playing.</span><a href="/docs/how/privacy/">Privacy</a></footer>
  </div>`;

const status = document.querySelector<HTMLElement>("#storage-status");
const detail = document.querySelector<HTMLElement>("#storage-detail");
if (!status || !detail) throw new Error("The storage status is missing");
const log = new EventLog();
try {
  if (import.meta.env.PROD && "serviceWorker" in navigator) await navigator.serviceWorker.register("/service-worker.js");
  const persisted = await requestPersistentStorage();
  await log.open();
  status.textContent = "Your progress stays on this device";
  detail.textContent = persisted
    ? "Practice modes are being prepared."
    : "Practice modes are being prepared. Your browser has not granted persistent storage.";
} catch (error) {
  status.textContent = "Could not open your practice space";
  detail.textContent = error instanceof Error ? error.message : String(error);
}

export function showDownloadProgress(progress: DownloadProgress): void {
  const section = document.querySelector<HTMLElement>("#download");
  const label = document.querySelector<HTMLElement>("#download-label");
  const bar = document.querySelector<HTMLProgressElement>("#download-progress");
  if (!section || !label || !bar) throw new Error("The download progress display is missing");
  section.hidden = false;
  label.textContent = `Preparing ${progress.file}`;
  if (progress.total === null) bar.removeAttribute("value");
  else { bar.max = progress.total; bar.value = progress.received; }
}
