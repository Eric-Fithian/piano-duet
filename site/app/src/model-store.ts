import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AssetId, DownloadProgress } from "./inference";

export interface ModelFile {
  model: AssetId;
  name: string;
  revision: string;
  url: string;
  sha256: string;
  bytes: number;
}

export class ModelStore {
  private cache = caches.open("piano-duet-models");

  async get(file: ModelFile, onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal): Promise<Response> {
    validateFile(file);
    const cache = await this.cache;
    const key = new Request(new URL(`/.piano-models/${encodeURIComponent(file.model)}/${encodeURIComponent(file.revision)}/${file.sha256}`, location.origin));
    const marker = new Request(new URL(`/.piano-models/verified/${encodeURIComponent(file.url)}/${file.sha256}/${file.bytes}`, location.origin));
    const cached = await cache.match(key);
    if (cached) {
      const [blob, recorded] = await Promise.all([cached.blob(), cache.match(marker)]);
      const verified = blob.size === file.bytes && (Boolean(recorded) || await verify(blob.stream(), file, () => {}, signal));
      if (!verified) {
        await Promise.all([cache.delete(key), cache.delete(marker)]);
        throw new Error(`Cached ${file.name} failed its integrity check. Retry to download it again.`);
      }
      if (!recorded) await cache.put(marker, new Response("verified"));
      return new Response(blob, { headers: cached.headers, status: cached.status });
    }
    const response = await fetch(file.url, { signal, mode: "cors" });
    if (!response.ok || !response.body) throw new Error(`Could not download ${file.name}: HTTP ${response.status}`);
    const [storage, checking] = response.body.tee();
    let complete = false;
    await cache.delete(marker);
    try {
      const writing = cache.put(key, new Response(storage, { headers: response.headers, status: response.status }));
      const checkingResult = verify(checking, file, (received) => onProgress({
        model: file.model, file: file.name, received, total: file.bytes,
      }), signal);
      const [written, checked] = await Promise.allSettled([writing, checkingResult]);
      if (written.status === "rejected") throw written.reason;
      if (checked.status === "rejected") throw checked.reason;
      if (!checked.value) throw new Error(`Downloaded ${file.name} failed its integrity check`);
      const result = await cache.match(key);
      if (!result) throw new Error(`Could not store ${file.name} on this device`);
      await cache.put(marker, new Response("verified"));
      complete = true;
      return result;
    } finally {
      if (!complete) await Promise.all([cache.delete(key), cache.delete(marker)]);
    }
  }
}

function validateFile(file: ModelFile): void {
  const url = new URL(file.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!(url.protocol === "https:" || (local && url.protocol === "http:")) || url.username || url.password || !file.name || !file.revision
      || !file.url.includes(file.revision) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || file.sha256.length !== 64 || ![...file.sha256].every((character) => "0123456789abcdef".includes(character))) {
    throw new Error("Model files need an immutable versioned URL, size and SHA-256 digest");
  }
}

async function verify(stream: ReadableStream<Uint8Array> | null, file: ModelFile,
  progress: (received: number) => void, signal?: AbortSignal): Promise<boolean> {
  if (!stream) throw new Error(`No data for ${file.name}`);
  const reader = stream.getReader();
  const hash = sha256.create();
  let received = 0;
  while (true) {
    signal?.throwIfAborted();
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > file.bytes) throw new Error(`${file.name} is larger than its manifest`);
    hash.update(chunk.value);
    progress(received);
  }
  return received === file.bytes && bytesToHex(hash.digest()) === file.sha256;
}
