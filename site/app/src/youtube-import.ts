import { localFetch } from "../../../src/piano_duet/static/practice.mjs";

type Video = { title: string; channel: string; url: string };

export function setupYoutubeImport(refresh: () => Promise<void>): void {
  const get = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`YouTube import is missing ${selector}`);
    return element;
  };
  const dialog = get<HTMLDialogElement>("#youtubeDialog"), form = get<HTMLFormElement>("#youtubeForm");
  const url = get<HTMLInputElement>("#youtubeUrl"), rights = get<HTMLInputElement>("#youtubeRights");
  const submit = get<HTMLButtonElement>("#youtubeGo"), error = get<HTMLElement>("#youtubeError");
  const progress = get<HTMLElement>("#youtubeProgress"), stage = get<HTMLElement>("#youtubeStage");
  const fill = get<HTMLElement>("#youtubeFill");
  const close = get<HTMLButtonElement>('[data-close="youtubeDialog"]');
  let controller: AbortController | undefined;
  const display = (message: string, fraction: number) => {
    progress.hidden = false; stage.textContent = message; fill.style.width = `${Math.round(fraction * 100)}%`;
  };
  get<HTMLButtonElement>("#importYoutubeLink").addEventListener("click", () => {
    error.hidden = true; progress.hidden = true; rights.checked = false; dialog.showModal();
  });
  dialog.addEventListener("close", () => controller?.abort());
  form.addEventListener("submit", (event) => {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!rights.checked || controller) return;
    const active = new AbortController(); controller = active;
    submit.disabled = true; close.textContent = "Cancel"; error.hidden = true; display("Downloading", 0);
    const run = async () => {
      const response = await fetch("/api/youtube-audio", { method: "POST", headers: { "Content-Type": "application/json", "X-Duet-Client": "1" },
        body: JSON.stringify({ url: url.value }), signal: active.signal, cache: "no-store" });
      if (!response.ok) {
        const body = response.headers.get("content-type")?.includes("application/json") ? await response.json() as { detail?: string } : null;
        throw new Error(body?.detail || `Download failed (HTTP ${response.status}).`);
      }
      const encoded = response.headers.get("X-Duet-Video");
      if (!encoded || !response.body) throw new Error("The server returned no audio or video details.");
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const video = JSON.parse(new TextDecoder().decode(bytes)) as Video;
      if (!video.title || !video.url || typeof video.channel !== "string") throw new Error("The server returned invalid video details.");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      const total = Number(response.headers.get("Content-Length"));
      let downloaded = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        downloaded += part.value.byteLength;
        if (downloaded > 128_000_000) throw new Error("This audio is too large to import.");
        chunks.push(part.value); display(total > 0 ? `Downloading ${Math.round(downloaded / total * 100)}%` : `Downloading ${Math.round(downloaded / 1_000_000)} MB`, total > 0 ? 0.3 * downloaded / total : 0);
      }
      if (!downloaded || (total > 0 && downloaded !== total)) throw new Error("The audio download was incomplete.");
      active.signal.throwIfAborted();
      display("Decoding", 0.3);
      const body = await new Blob(chunks as BlobPart[]).arrayBuffer();
      const params = new URLSearchParams({ filename: "YouTube audio", rights: "1", youtubeTitle: video.title.slice(0, 200), youtubeChannel: video.channel.slice(0, 200) });
      const saved = await localFetch(`/api/library/import-audio?${params}`, { method: "POST", body, signal: active.signal });
      if (!saved.ok) throw new Error((await saved.json()).detail);
      active.signal.throwIfAborted();
      await refresh(); display("Score saved to your library", 1); url.value = ""; dialog.close();
    };
    run().catch((cause: unknown) => {
      if (active.signal.aborted) return;
      error.textContent = `${cause instanceof Error ? cause.message : String(cause)} Try Import audio or Record audio instead.`;
      error.hidden = false; progress.hidden = true;
    }).finally(() => { if (controller === active) controller = undefined; submit.disabled = false; close.textContent = "Done"; });
  }, true);
}
