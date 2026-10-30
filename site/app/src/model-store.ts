import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DownloadProgress, ModelId } from "./inference";

export interface ModelFile {
  model: ModelId;
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
    const cached = await cache.match(key);
    if (cached) {
      const verified = await verify(cached.clone().body, file, () => {}, signal);
      if (!verified) {
        await cache.delete(key);
        throw new Error(`Cached ${file.name} failed its integrity check. Retry to download it again.`);
      }
      return cached;
    }
    const response = await fetch(file.url, { signal, mode: "cors" });
    if (!response.ok || !response.body) throw new Error(`Could not download ${file.name}: HTTP ${response.status}`);
    const [storage, checking] = response.body.tee();
    const staging = new Request(new URL(`/.piano-models/staging/${crypto.randomUUID()}`, location.origin));
    try {
      const writing = cache.put(staging, new Response(storage, { headers: response.headers, status: response.status }));
      const checkingResult = verify(checking, file, (received) => onProgress({
        model: file.model, file: file.name, received, total: file.bytes,
      }), signal);
      const [written, checked] = await Promise.allSettled([writing, checkingResult]);
      if (written.status === "rejected") throw written.reason;
      if (checked.status === "rejected") throw checked.reason;
      if (!checked.value) throw new Error(`Downloaded ${file.name} failed its integrity check`);
      const complete = await cache.match(staging);
      if (!complete) throw new Error(`Downloaded ${file.name} is missing from device storage`);
      await cache.put(key, complete);
      const result = await cache.match(key);
      if (!result) throw new Error(`Could not store ${file.name} on this device`);
      return result;
    } finally {
      await cache.delete(staging);
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
