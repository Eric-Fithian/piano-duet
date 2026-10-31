import { localFetch } from "../../../src/piano_duet/static/practice.mjs";
import type { BrowserRecordingImporter } from "./recording-import";

export function recordingStage(value: string): void {
  const status = document.querySelector<HTMLElement>("#recordingImportStatus"), dialog = document.querySelector<HTMLElement>("#recordingStage");
  if (!status || !dialog) throw new Error("Recording import has no progress display");
  status.textContent = value; dialog.textContent = value;
}

export function setupRecordingUi(importer: BrowserRecordingImporter, refresh: () => Promise<void>): void {
  const get = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Recording import is missing ${selector}`);
    return element;
  };
  const dialog = get<HTMLDialogElement>("#recordingDialog"), form = get<HTMLFormElement>("#recordingForm");
  const file = get<HTMLInputElement>("#recordingFile"), rights = get<HTMLInputElement>("#recordingRights");
  const toggle = get<HTMLButtonElement>("#recordingToggle"), submit = get<HTMLButtonElement>("#recordingGo");
  const label = get<HTMLElement>("#recordingFileLabel"), selection = get<HTMLElement>("#recordingSelection");
  const error = get<HTMLElement>("#recordingError");
  let stream: MediaStream | undefined, recorder: MediaRecorder | undefined, recording: File | undefined, chunks: Blob[] = [], generation = 0;
  const fail = (cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); error.hidden = false; };
  const open = (capture: boolean) => {
    generation++;
    error.hidden = true; recording = undefined; file.value = ""; rights.checked = false; selection.textContent = "";
    recordingStage("Preparing recording import");
    label.hidden = capture; toggle.hidden = !capture; toggle.textContent = "Start recording";
    dialog.showModal();
    importer.prepare().catch(fail);
  };
  get<HTMLButtonElement>("#importAudio").addEventListener("click", () => open(false));
  get<HTMLButtonElement>("#recordAudio").addEventListener("click", () => open(true));
  get<HTMLButtonElement>("#recordingClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    generation++;
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
  });
  toggle.addEventListener("click", () => {
    if (recorder?.state === "recording") { recorder.stop(); return; }
    const current = generation;
    toggle.disabled = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then((media) => {
      if (current !== generation || !dialog.open) { media.getTracks().forEach((track) => track.stop()); return; }
      stream = media; chunks = []; recording = undefined;
      const active = new MediaRecorder(media); recorder = active;
      active.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      active.onerror = () => { media.getTracks().forEach((track) => track.stop()); fail(new Error("Recording failed")); };
      active.onstop = () => {
        media.getTracks().forEach((track) => track.stop()); stream = undefined;
        if (current !== generation) return;
        const mime = active.mimeType || chunks[0]?.type || "audio/webm";
        const extension = mime.includes("mp4") ? "m4a" : "webm";
        recording = new File(chunks, `Recording.${extension}`, { type: mime });
        selection.textContent = "Recording ready"; toggle.textContent = "Record again";
      };
      active.start(); toggle.textContent = "Stop recording"; selection.textContent = "Recording…";
    }).catch(fail).finally(() => { toggle.disabled = false; });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = toggle.hidden ? file.files?.[0] : recording;
    if (!selected || !selected.size) { fail(new Error("Choose or record some audio first")); return; }
    if (!rights.checked) { fail(new Error("Confirm that you have the rights to transcribe this recording")); return; }
    submit.disabled = true; error.hidden = true;
    const params = new URLSearchParams({ filename: selected.name, rights: "1" });
    selected.arrayBuffer().then((body) => localFetch(`/api/library/import-audio?${params}`, { method: "POST", body }))
      .then(async (response: Response) => {
        if (!response.ok) throw new Error((await response.json()).detail);
        await refresh(); recordingStage("Score saved to your library"); dialog.close();
      }).catch(fail).finally(() => { submit.disabled = false; });
  });
}
