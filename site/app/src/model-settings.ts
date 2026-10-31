import { MODEL_CATALOG } from "./model-catalog";
import { ModelStore } from "./model-store";
import { acquireModelLock, withModelWriteLock } from "./model-lock";
import { PIANO_SAMPLES, SAMPLE_REVISION } from "./piano-samples";
import { testModel } from "./model-self-test";
import type { AssetId, DownloadProgress, InferenceBackend, InferenceBackendRecord, ModelFile, ModelId } from "./inference";

export type ModelSettingsEntry = { id: AssetId; name: string; use: string; credit: string; files: ModelFile[]; used: boolean };
type Entry = ModelSettingsEntry;
type Result = { passed: boolean; text: string; backend?: InferenceBackendRecord };
const sampleFiles: ModelFile[] = PIANO_SAMPLES.map((sample) => ({ model: "piano-samples", name: sample.file,
  revision: SAMPLE_REVISION, url: `https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/${SAMPLE_REVISION}/samples/piano/${sample.file}`,
  bytes: sample.bytes, sha256: sample.sha256 }));
const definitions: Omit<Entry, "files">[] = [
  { id: "aria", name: "Aria", use: "Generates Reading and Drills material, plus Duet replies and Variations (turned off).", credit: "Apache 2.0 · EleutherAI Aria", used: true },
  { id: "live-transcription", name: "Live note recognition", use: "Recognizes notes as you play in Reading and Library, and in Practice (turned off).", credit: "CC BY 4.0 · Qiuqiang Kong and collaborators", used: true },
  { id: "phrase-transcription", name: "Phrase transcription", use: "Recognizes phrases for Practice, Duet and Variations (turned off).", credit: "CC BY 4.0 · Qiuqiang Kong and collaborators; ONNX conversion by stelee", used: false },
  { id: "recording-transcription", name: "Recording transcription", use: "Finds notes in Drills takes and Library recordings.", credit: "MIT · Transkun by Yujia Yan", used: true },
  { id: "midi-to-score", name: "Score model", use: "Writes sheet music for Library recording imports.", credit: "CC BY-NC-SA 4.0 · Score model by Eric Fithian", used: true },
  { id: "piano-samples", name: "Piano samples", use: "Plays piano sounds throughout the app.", credit: "CC BY 3.0 · tonejs-instruments by Nicholaus P. Brosowsky", used: true },
];
const entries: Entry[] = definitions.map((entry) => {
  const files = entry.id === "piano-samples" ? sampleFiles : MODEL_CATALOG[entry.id];
  if (!files?.length) throw new Error(`Missing catalog files for ${entry.id}`);
  return { ...entry, files };
});
const size = (bytes: number) => bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
  : bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1000 ? `${(bytes / 1000).toFixed(1)} KB` : `${bytes} B`;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

export function setupModelSettings(root: HTMLDetailsElement, backend: InferenceBackend,
  options: { entries?: Entry[]; store?: Pick<ModelStore, "get" | "status" | "delete" | "verifyStored">; test?: typeof testModel } = {}): { backend: (model: ModelId, record: InferenceBackendRecord) => void; progress: (value: DownloadProgress) => void } {
  const store = options.store ?? new ModelStore();
  const items = options.entries ?? entries;
  const runTest = options.test ?? testModel;
  const backends = new Map<ModelId, InferenceBackendRecord>();
  const results = new Map<AssetId, Result>();
  const controllers = new Map<AssetId, AbortController>();
  let bulkActive = false, bulkCancelled = false;
  const rows = new Map<AssetId, { section: HTMLDetailsElement; status: HTMLElement; backend: HTMLElement; result: HTMLElement; progress: HTMLProgressElement; cancel: HTMLButtonElement }>();
  root.innerHTML = `<summary>Models</summary><p>Models run entirely on this device. Each model is downloaded from Hugging Face the first time a feature needs it and stored in this browser. If the browser clears it, it downloads again. No audio leaves this device. Piano samples come from GitHub.</p><p id="modelStorage" role="status"></p><div class="model-actions"><button class="secondary" type="button" data-action="persist">Keep storage on this device</button><button class="secondary" type="button" data-action="download-all">Download all models used by the app · ${size(items.filter((entry) => entry.used).flatMap((entry) => entry.files).reduce((sum, file) => sum + file.bytes, 0))}</button><button class="secondary" type="button" data-action="test-all">Test all</button><button class="secondary" type="button" data-action="copy">Copy diagnostics</button><button class="text-button" type="button" data-action="cancel-all" hidden>Cancel all</button></div><p class="model-message" role="status" aria-live="polite"></p><div class="model-actions model-confirm" hidden><button class="secondary" type="button" data-action="confirm-test-all">Download and test</button><button class="text-button" type="button" data-action="cancel-test-all">Cancel</button></div><div class="model-list"></div>`;
  const storage = root.querySelector<HTMLElement>("#modelStorage")!;
  const message = root.querySelector<HTMLElement>(".model-message")!;
  const list = root.querySelector<HTMLElement>(".model-list")!;
  for (const entry of items) {
    const section = document.createElement("details");
    section.className = "model-entry";
    const repos = [...new Set(entry.files.map((file) => file.model === "piano-samples"
      ? `https://github.com/nbrosowsky/tonejs-instruments/tree/${file.revision}/samples/piano`
      : file.url.split("/resolve/")[0] + `/tree/${file.revision}`))];
    section.innerHTML = `<summary class="model-row"><span class="model-name"></span><span class="model-size"></span><span class="model-status" role="status">Checking…</span></summary><div class="model-detail"><p class="model-use"></p><p class="model-credit"></p><p class="model-links"></p><p class="model-backend">Backend: not yet run</p><progress hidden></progress><p class="model-result" role="status"></p><div class="model-actions"><button class="secondary" type="button" data-action="download" hidden>Download</button><button class="secondary" type="button" data-action="test" hidden>Test</button><button class="secondary" type="button" data-action="redownload" hidden>Re-download</button><button class="text-button" type="button" data-action="delete" hidden>Delete</button><button class="secondary" type="button" data-action="cancel" hidden>Cancel</button></div></div>`;
    section.querySelector(".model-name")!.textContent = entry.name;
    if (!entry.used) { const note = document.createElement("span"); note.className = "model-note"; note.textContent = "Not needed now"; section.querySelector(".model-name")!.append(note); }
    section.querySelector(".model-size")!.textContent = size(entry.files.reduce((sum, file) => sum + file.bytes, 0));
    section.querySelector(".model-use")!.textContent = entry.use;
    section.querySelector(".model-credit")!.textContent = entry.credit;
    if (entry.id === "piano-samples") section.querySelector(".model-backend")!.textContent = "Uses the browser's audio decoder.";
    const links = section.querySelector(".model-links")!;
    repos.forEach((url, index) => { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = repos.length > 1 ? `Source ${index + 1}` : "Source at pinned revision"; links.append(a, " "); });
    const row = { section, status: section.querySelector<HTMLElement>(".model-status")!, backend: section.querySelector<HTMLElement>(".model-backend")!,
      result: section.querySelector<HTMLElement>(".model-result")!, progress: section.querySelector<HTMLProgressElement>("progress")!, cancel: section.querySelector<HTMLButtonElement>("[data-action=cancel]")! };
    rows.set(entry.id, row); list.append(section);
    section.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.action;
      if (!action) return;
      if (action === "cancel") { controllers.get(entry.id)?.abort(); return; }
      void perform(entry, action).catch((error: unknown) => { row.result.textContent = results.get(entry.id)?.text ?? `Failed: ${reason(error)}`; });
    });
    if (entry.id !== "piano-samples") {
      const previous = localStorage.getItem(`piano-duet-backend:${entry.id}`);
      if (previous) reportBackend(entry.id, JSON.parse(previous) as InferenceBackendRecord);
    }
  }
  async function refreshStorage(): Promise<void> {
    const estimate = await navigator.storage.estimate();
    const persistent = await navigator.storage.persisted();
    const usage = estimate.usage === undefined ? "unknown usage" : `${size(estimate.usage)} used`;
    const quota = estimate.quota === undefined ? "unknown quota" : `${size(estimate.quota)} quota`;
    storage.textContent = `Browser storage: ${usage} · ${quota}. ${persistent ? "Storage is persistent." : "Storage is not persistent; the browser may clear it."}`;
  }
  async function refresh(entry: Entry): Promise<void> {
    const row = rows.get(entry.id)!;
    const status = await store.status(entry.files);
    row.status.textContent = status === "downloaded" ? "Downloaded" : status === "partially downloaded" ? "Partial" : "Not downloaded";
    row.status.dataset.state = status;
    for (const button of row.section.querySelectorAll<HTMLButtonElement>(".model-actions button")) {
      const action = button.dataset.action;
      if (action === "cancel") continue;
      button.hidden = action === "download" ? status === "downloaded" : action === "test" ? status !== "downloaded" : status === "not downloaded";
    }
  }
  async function download(entry: Entry, signal: AbortSignal): Promise<void> {
    const row = rows.get(entry.id)!;
    const total = entry.files.reduce((sum, file) => sum + file.bytes, 0);
    let finished = 0;
    row.progress.hidden = false; row.progress.max = total; row.progress.value = 0;
    for (const file of entry.files) {
      signal.throwIfAborted();
      await store.get(file, (progress: DownloadProgress) => { row.progress.value = finished + progress.received; row.status.textContent = `Downloading ${Math.floor(100 * row.progress.value / total)}%`; }, signal);
      finished += file.bytes; row.progress.value = finished;
    }
  }
  async function perform(entry: Entry, action: string): Promise<void> {
    if (controllers.has(entry.id)) throw new Error(`${entry.name} is already busy`);
    const controller = new AbortController(); controllers.set(entry.id, controller);
    results.delete(entry.id);
    const row = rows.get(entry.id)!; row.cancel.hidden = false; row.result.textContent = "";
    const started = performance.now();
    try {
      if (action === "test") {
        const release = await acquireModelLock(entry.id, controller.signal);
        try {
          row.result.textContent = "Verifying files…";
          const total = entry.files.reduce((sum, file) => sum + file.bytes, 0);
          let verified = 0;
          row.progress.hidden = false; row.progress.max = total; row.progress.value = 0;
          for (const file of entry.files) {
            await store.verifyStored(file, (progress) => {
              row.progress.value = verified + progress.received;
              row.status.textContent = `Verifying ${Math.floor(100 * row.progress.value / total)}%`;
            }, controller.signal);
            verified += file.bytes;
          }
          row.progress.hidden = true; row.result.textContent = "Testing…";
          const result = await runTest(entry.id, backend, store, controller.signal, (progress) => {
            row.progress.hidden = false;
            row.progress.max = progress.total ?? 1;
            row.progress.value = progress.received;
            row.status.textContent = `Downloading ${progress.total ? Math.floor(100 * progress.received / progress.total) + "%" : "…"}`;
          }, (record) => { if (entry.id !== "piano-samples") reportBackend(entry.id, record); });
          if (!result.passed) throw new Error(result.text);
          results.set(entry.id, result); row.result.textContent = result.text;
          if (result.backend && entry.id !== "piano-samples") reportBackend(entry.id, result.backend);
        } finally { release(); }
      } else {
        await withModelWriteLock(entry.id, async () => {
          if (action === "delete" || action === "redownload") await store.delete(entry.files);
          if (action === "download" || action === "redownload") await download(entry, controller.signal);
        });
      }
    } catch (error) {
      if (action === "test") {
        const failure = { passed: false, text: `Failed after ${Math.round(performance.now() - started)} ms: ${reason(error)}` };
        results.set(entry.id, failure); row.result.textContent = failure.text;
      }
      throw error;
    } finally {
      controllers.delete(entry.id); row.cancel.hidden = true; row.progress.hidden = true;
      await refresh(entry); await refreshStorage();
    }
  }
  root.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.action;
    if (!action || !["persist", "download-all", "test-all", "confirm-test-all", "cancel-test-all", "cancel-all", "copy"].includes(action)) return;
    void (async () => {
      if (action === "cancel-all") { bulkCancelled = true; for (const controller of controllers.values()) controller.abort(); return; }
      message.textContent = "";
      const confirmation = root.querySelector<HTMLElement>(".model-confirm")!;
      if (action === "cancel-test-all") { confirmation.hidden = true; return; }
      if (action === "test-all") {
        const missing = await Promise.all(items.map(async (entry) => ({ entry,
          files: (await Promise.all(entry.files.map(async (file) => ({ file, status: await store.status([file]) }))))
            .filter(({ status }) => status !== "downloaded").map(({ file }) => file) })));
        const needed = missing.filter(({ files }) => files.length);
        if (needed.length) {
          const bytes = needed.flatMap(({ files }) => files).reduce((sum, file) => sum + file.bytes, 0);
          message.textContent = `Test all will first download up to ${size(bytes)} for ${needed.map(({ entry }) => entry.name).join(", ")}.`;
          confirmation.hidden = false;
          return;
        }
      }
      if (action === "confirm-test-all") confirmation.hidden = true;
      if (action === "persist") { const granted = await navigator.storage.persist(); message.textContent = granted ? "Persistent storage granted." : "The browser did not grant persistent storage."; await refreshStorage(); }
      if (action === "download-all" || action === "test-all" || action === "confirm-test-all") {
        if (bulkActive) throw new Error("A bulk operation is already in progress");
        bulkActive = true; bulkCancelled = false;
        const cancelAll = root.querySelector<HTMLButtonElement>("[data-action=cancel-all]")!;
        cancelAll.hidden = false;
        const testing = action !== "download-all";
        let failures = 0;
        const selected = items.filter((item) => testing || item.used);
        const unavailable = new Set<AssetId>();
        try {
          if (action === "confirm-test-all") for (const entry of selected) {
            if (bulkCancelled) break;
            try { await perform(entry, "download"); }
            catch (error) { failures++; unavailable.add(entry.id); rows.get(entry.id)!.result.textContent = `Failed: ${reason(error)}`; }
          }
          for (const entry of selected) {
            if (bulkCancelled) break;
            if (unavailable.has(entry.id)) continue;
            try { await perform(entry, testing ? "test" : "download"); }
            catch (error) { failures++; rows.get(entry.id)!.result.textContent = results.get(entry.id)?.text ?? `Failed: ${reason(error)}`; }
          }
        } finally {
          bulkActive = false; cancelAll.hidden = true;
        }
        message.textContent = bulkCancelled ? "Cancelled." : failures ? `${failures} ${testing ? "tests" : "downloads"} failed. See the details above.` : testing ? "All tests passed." : "Downloads complete.";
      }
      if (action === "copy") {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: unknown } | null> } }).gpu;
        const adapter = gpu ? await gpu.requestAdapter() : null;
        const info = adapter?.info as { vendor?: string; architecture?: string; device?: string; description?: string } | undefined;
        const statuses = await Promise.all(items.map(async (entry) => ({ model: entry.name, status: await store.status(entry.files), backend: backends.get(entry.id as ModelId), test: results.get(entry.id) })));
        await navigator.clipboard.writeText(JSON.stringify({ browser: navigator.userAgent, crossOriginIsolated,
          adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null,
          storage: await navigator.storage.estimate(), persistent: await navigator.storage.persisted(), models: statuses }, null, 2));
        message.textContent = "Diagnostics copied.";
      }
    })().catch((error: unknown) => { message.textContent = reason(error); });
  });
  root.addEventListener("toggle", () => { if (root.open) void Promise.all([refreshStorage(), ...items.map(refresh)]).catch((error: unknown) => { message.textContent = reason(error); }); });
  function reportBackend(model: ModelId, record: InferenceBackendRecord): void {
    const safeRecord = { provider: record.provider, ...(record.fallback ? { fallback: { provider: record.fallback.provider, message: record.fallback.message } } : {}) };
    backends.set(model, safeRecord);
    localStorage.setItem(`piano-duet-backend:${model}`, JSON.stringify(safeRecord));
    const row = rows.get(model);
    const label = record.provider === "webgpu" ? "WebGPU" : record.provider === "wasm" ? "WASM" : "Native";
    if (row) row.backend.textContent = `Last backend: ${label}${record.fallback ? ` (WebGPU: ${record.fallback.message})` : model === "recording-transcription" && record.provider === "wasm" ? " (this model uses WASM)" : record.provider === "webgpu" && (model === "live-transcription" || model === "phrase-transcription") ? " + WASM" : ""}`;
    const entry = items.find((item) => item.id === model);
    if (entry) void refresh(entry).catch((error: unknown) => { if (row) row.result.textContent = reason(error); });
  }
  return { backend: reportBackend, progress: (value) => {
    const row = rows.get(value.model);
    if (!row || controllers.has(value.model)) return;
    row.status.textContent = `Downloading ${value.total ? Math.floor(100 * value.received / value.total) + "%" : "…"}`;
    if (value.total !== null && value.received === value.total) {
      const entry = items.find((item) => item.id === value.model);
      if (entry) void refresh(entry).catch((error: unknown) => { row.result.textContent = reason(error); });
    }
  } };
}
