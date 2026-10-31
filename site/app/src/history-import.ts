import type { PracticeEvent } from "./events";
import type { EventLog } from "./event-log";
import { LocalService } from "../../../src/core/local-service.ts";

type ImportResult = { events: PracticeEvent[]; counts: Record<string, number>; error?: string };

export function setupHistoryImport(log: EventLog, refresh: () => Promise<void>): void {
  const input = document.querySelector<HTMLInputElement>("#historyFile"), status = document.querySelector<HTMLElement>("#historyImportStatus");
  const progress = document.querySelector<HTMLProgressElement>("#historyImportProgress");
  if (!input || !status || !progress) throw new Error("The history import controls are missing");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    input.disabled = true;
    progress.hidden = false;
    status.textContent = "Reading history…";
    let saved = false;
    const run = async () => {
      const bytes = await file.arrayBuffer();
      const worker = new Worker(new URL("./history-import-worker.ts", import.meta.url), { type: "module" });
      const result = await new Promise<ImportResult>((resolve, reject) => {
        worker.onmessage = ({ data }: MessageEvent<ImportResult>) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error("The history worker returned an unreadable result"));
        worker.postMessage(bytes, [bytes]);
      }).finally(() => worker.terminate());
      if (result.error) throw new Error(result.error);
      status.textContent = "Checking history…";
      const existing = await log.list(), ids = new Set(existing.map((event) => event.id));
      const combined = [...existing, ...result.events.filter((event) => !ids.has(event.id))];
      const preview = new LocalService({ async list() { return combined; } });
      for (const endpoint of ["profile", "drills", "library", "pieces"]) {
        const response = await preview.fetch(`/api/${endpoint}`);
        if (!response.ok) throw new Error(`Could not rebuild ${endpoint} from this history`);
      }
      status.textContent = "Saving history…";
      const added = await log.merge(result.events);
      saved = true;
      await refresh();
      const { attempts, tasks, pieces, songs, song_plays } = result.counts;
      status.textContent = `Imported ${added} new events from ${attempts} attempts, ${tasks} tasks, ${pieces} saved pieces, ${songs} songs and ${song_plays} song plays.`;
    };
    void run().catch((error: unknown) => { status.textContent = `${saved ? "History was saved, but refresh failed" : "Import failed"}: ${error instanceof Error ? error.message : String(error)}`; })
      .finally(() => { progress.hidden = true; input.disabled = false; input.value = ""; });
  });
}
