import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DownloadProgress, ModelFile } from "./inference.ts";

export class ModelStore {
  private cache = caches.open("piano-duet-models");

  async status(files: ModelFile[]): Promise<"downloaded" | "partially downloaded" | "not downloaded"> {
    if (!files.length) throw new Error("A model must have files");
    const cache = await this.cache;
    const present = await Promise.all(files.map(async (file) => {
      validateFile(file);
      const response = await cache.match(fileKey(file));
      if (!response) return "missing";
      const length = response.headers.get("content-length");
      return (length === null || Number(length) === file.bytes) && Boolean(await cache.match(markerKey(file))) ? "verified" : "incomplete";
    }));
    return present.every((state) => state === "verified") ? "downloaded"
      : present.some((state) => state !== "missing") ? "partially downloaded" : "not downloaded";
  }

  async delete(files: ModelFile[]): Promise<void> {
    const cache = await this.cache;
    await Promise.all(files.map(async (file) => {
      validateFile(file);
      await Promise.all([cache.delete(fileKey(file)), cache.delete(markerKey(file))]);
    }));
  }

  async verifyStored(file: ModelFile, onProgress: (progress: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
    validateFile(file);
    const cache = await this.cache;
    const response = await cache.match(fileKey(file));
    if (!response) throw new Error(`${file.name} is not downloaded`);
    let valid: boolean;
    try {
      valid = await verify(response.body, file, (received) => onProgress({
        model: file.model, file: file.name, received, total: file.bytes,
      }), signal);
    } catch (error) {
      if (error instanceof Error && error.message === `${file.name} is larger than its manifest`) await cache.delete(markerKey(file));
      throw error;
    }
    if (!valid) {
      await cache.delete(markerKey(file));
      throw new Error(`Cached ${file.name} failed its integrity check. Re-download it to try again.`);
    }
  }

  async get(file: ModelFile, onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal): Promise<Response> {
    validateFile(file);
    const cache = await this.cache;
    const key = fileKey(file);
    const marker = markerKey(file);
    const cached = await cache.match(key);
    if (cached) {
      // WebKit cannot read a cached model this large back as one Blob, so the response is only ever streamed.
      const length = cached.headers.get("content-length");
      const recorded = await cache.match(marker);
      const verified = (length === null || Number(length) === file.bytes)
        && (Boolean(recorded) || await verify(cached.clone().body, file, () => {}, signal));
      if (!verified) {
        await Promise.all([cache.delete(key), cache.delete(marker)]);
        throw new Error(`Cached ${file.name} failed its integrity check. Retry to download it again.`);
      }
      if (!recorded) await cache.put(marker, new Response("verified"));
      return cached;
    }
    const host = new URL(file.url).host;
    const response = await fetch(file.url, { signal, mode: "cors" }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      throw new Error(`Could not reach ${host} to download ${file.name}. Check your connection, or allow ${host} in any content blocker or tracking protection, then try again.`, { cause: error });
    });
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

export async function readModelBytes(response: Response, file: ModelFile, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error(`No data for ${file.name}`);
  const bytes = new Uint8Array(file.bytes);
  const reader = response.body.getReader();
  let offset = 0;
  while (true) {
    signal?.throwIfAborted();
    const chunk = await reader.read();
    if (chunk.done) break;
    if (offset + chunk.value.byteLength > file.bytes) throw new Error(`${file.name} is larger than its manifest`);
    bytes.set(chunk.value, offset);
    offset += chunk.value.byteLength;
  }
  if (offset !== file.bytes) throw new Error(`${file.name} ended after ${offset} of ${file.bytes} bytes`);
  return bytes;
}

function fileKey(file: ModelFile): Request {
  return new Request(new URL(`/.piano-models/${encodeURIComponent(file.model)}/${encodeURIComponent(file.revision)}/${file.sha256}`, location.origin));
}

function markerKey(file: ModelFile): Request {
  return new Request(new URL(`/.piano-models/verified/${encodeURIComponent(file.url)}/${file.sha256}/${file.bytes}`, location.origin));
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
