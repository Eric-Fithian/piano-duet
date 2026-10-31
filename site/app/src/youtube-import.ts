import { localFetch } from "../../../src/piano_duet/static/practice.mjs";
import { captureTabAudio } from "./tab-audio.ts";
import type { TabCapture } from "./tab-audio.ts";
import { checkYoutubeUrl, missingAudioMessage, tabCaptureUnavailable, UNSUPPORTED_TAB_AUDIO } from "./youtube-link.ts";

export function setupYoutubeImport(refresh: () => Promise<void>): void {
  const get = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`YouTube import is missing ${selector}`);
    return element;
  };
  const dialog = get<HTMLDialogElement>("#youtubeDialog"), form = get<HTMLFormElement>("#youtubeForm");
  const url = get<HTMLInputElement>("#youtubeUrl"), rights = get<HTMLInputElement>("#youtubeRights");
  const title = get<HTMLInputElement>("#youtubeVideoTitle"), channel = get<HTMLInputElement>("#youtubeChannel");
  const submit = get<HTMLButtonElement>("#youtubeGo"), stop = get<HTMLButtonElement>("#youtubeStop");
  const error = get<HTMLElement>("#youtubeError"), support = get<HTMLElement>("#youtubeSupport");
  const record = get<HTMLButtonElement>("#youtubeRecord"), close = get<HTMLButtonElement>('[data-close="youtubeDialog"]');
  const progress = get<HTMLElement>("#youtubeProgress"), stage = get<HTMLElement>("#youtubeStage");
  const fill = get<HTMLElement>("#youtubeFill");
  let controller: AbortController | undefined, capture: TabCapture | undefined, stream: MediaStream | undefined;
  let timer: number | undefined, cap: number | undefined, finishing = false, currentLink = "";
  const unavailable = () => tabCaptureUnavailable(typeof navigator.mediaDevices?.getDisplayMedia === "function", navigator.userAgent, navigator.maxTouchPoints);
  const showSupport = (message: string) => { support.textContent = message; support.hidden = false; record.hidden = false; };
  const reset = () => {
    window.clearInterval(timer); window.clearTimeout(cap); timer = undefined; cap = undefined;
    submit.disabled = false; stop.hidden = true; stop.disabled = false; close.textContent = "Done"; finishing = false;
  };
  const fail = (cause: unknown) => {
    error.textContent = cause instanceof Error ? cause.message : String(cause);
    error.hidden = false; progress.hidden = true;
  };
  const finish = async () => {
    if (!controller || !capture || finishing) return;
    finishing = true; stop.disabled = true; window.clearInterval(timer); window.clearTimeout(cap);
    const active = controller;
    try {
      stage.textContent = "Preparing audio";
      const body = await capture.stop(); capture = undefined; stream = undefined;
      active.signal.throwIfAborted();
      stage.textContent = "Transcribing";
      const params = new URLSearchParams({ filename: "YouTube audio.wav", rights: "1", youtubeTitle: title.value.trim() || "YouTube recording",
        youtubeChannel: channel.value.trim(), youtubeUrl: currentLink });
      const saved = await localFetch(`/api/library/import-audio?${params}`, { method: "POST", body, signal: active.signal });
      if (!saved.ok) throw new Error((await saved.json()).detail);
      active.signal.throwIfAborted();
      await refresh(); url.value = ""; dialog.close();
    } catch (cause) { if (!active.signal.aborted) fail(cause); }
    finally { if (controller === active) { controller = undefined; capture = undefined; stream = undefined; reset(); } }
  };
  get<HTMLButtonElement>("#openYoutube").addEventListener("click", () => {
    error.hidden = true; support.hidden = true; record.hidden = true; rights.checked = false; title.value = "YouTube recording"; channel.value = "";
    if (unavailable()) showSupport(UNSUPPORTED_TAB_AUDIO);
  });
  record.addEventListener("click", () => { dialog.close(); get<HTMLButtonElement>("#recordAudio").click(); });
  dialog.addEventListener("close", () => {
    const active = controller; controller = undefined; active?.abort();
    stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
    if (capture) void capture.cancel();
    capture = undefined;
    reset();
  });
  stop.addEventListener("click", () => { void finish(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!rights.checked || controller) return;
    error.hidden = true; support.hidden = true; record.hidden = true;
    if (unavailable()) { showSupport(UNSUPPORTED_TAB_AUDIO); return; }
    let link: string;
    try { link = checkYoutubeUrl(url.value.trim()); }
    catch (cause) { fail(cause); return; }
    currentLink = link;
    const active = new AbortController(); controller = active;
    submit.disabled = true; close.textContent = "Cancel";
    window.open(link, "_blank", "noopener,noreferrer");
    const options = { video: true, audio: true, selfBrowserSurface: "exclude", preferCurrentTab: false, surfaceSwitching: "exclude" } as DisplayMediaStreamOptions;
    navigator.mediaDevices.getDisplayMedia(options).then(async (selected) => {
      if (active.signal.aborted) { selected.getTracks().forEach((track) => track.stop()); return; }
      stream = selected;
      selected.getVideoTracks().forEach((track) => { track.stop(); selected.removeTrack(track); });
      const audio = selected.getAudioTracks()[0];
      if (!audio) { showSupport(missingAudioMessage(navigator.userAgent)); selected.getTracks().forEach((track) => track.stop()); stream = undefined; return; }
      const nextCapture = await captureTabAudio(selected, active.signal, () => { void finish(); }, (cause) => {
        if (active.signal.aborted) return;
        active.abort(); selected.getTracks().forEach((track) => track.stop());
        if (capture) void capture.cancel();
        capture = undefined; stream = undefined; controller = undefined; reset(); fail(cause);
      });
      if (active.signal.aborted) { await nextCapture.cancel(); return; }
      capture = nextCapture;
      audio.addEventListener("ended", () => { void finish(); }, { once: true });
      if (audio.readyState === "ended") { await finish(); return; }
      const started = performance.now();
      progress.hidden = false; fill.style.width = "0%"; stop.hidden = false;
      const tick = () => {
        const elapsed = Math.floor((performance.now() - started) / 1000);
        stage.textContent = `Recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} · Play the video, then stop sharing`;
        fill.style.width = `${Math.min(100, elapsed / 900 * 100)}%`;
      };
      tick(); timer = window.setInterval(tick, 1000); cap = window.setTimeout(() => { void finish(); }, 900_000);
    }).catch((cause: unknown) => {
      if (controller === active) { stream?.getTracks().forEach((track) => track.stop()); stream = undefined; }
      if (!active.signal.aborted && !(cause instanceof DOMException && cause.name === "NotAllowedError")) fail(cause);
    }).finally(() => {
      if (!capture && controller === active && !finishing) { controller = undefined; reset(); }
    });
  }, true);
}
