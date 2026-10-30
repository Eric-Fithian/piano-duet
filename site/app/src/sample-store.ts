import { ModelStore } from "./model-store";
import { PIANO_SAMPLES, SAMPLE_REVISION } from "./piano-samples";
import type { DownloadProgress } from "./inference";

export interface SampleFile { pitch: number; file: string; sha256: string; bytes: number }

export class SampleStore {
  private readonly store: ModelStore;
  private readonly samples: SampleFile[];
  private readonly revision: string;
  private readonly onProgress: (progress: DownloadProgress) => void;

  constructor(onProgress: (progress: DownloadProgress) => void, samples = PIANO_SAMPLES,
    revision = SAMPLE_REVISION, store = new ModelStore()) {
    this.onProgress = onProgress;
    this.samples = samples;
    this.revision = revision;
    this.store = store;
  }

  async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    if ((options.method ?? "GET").toUpperCase() !== "GET") return Response.json({ detail: "Piano samples are read-only" }, { status: 405 });
    if (path === "/samples/manifest.json") return Response.json(this.samples);
    const prefix = "/samples/";
    if (!path.startsWith(prefix)) throw new Error("Invalid piano sample path");
    const name = path.slice(prefix.length);
    const sample = this.samples.find((item) => item.file === name);
    if (!sample) return Response.json({ detail: "Unknown piano sample" }, { status: 404 });
    const response = await this.store.get({ model: "piano-samples", name, revision: this.revision,
      url: `https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/${this.revision}/samples/piano/${name}`,
      sha256: sample.sha256, bytes: sample.bytes }, this.onProgress, options.signal ?? undefined);
    this.onProgress({ model: "piano-samples", file: name, received: sample.bytes, total: sample.bytes });
    return response;
  }
}
