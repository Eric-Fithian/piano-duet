import { decodeAudioFile } from "./audio-decoder.ts";
import type { DownloadProgress, InferenceBackend, InferenceSession, PianoNote } from "./inference.ts";

export class NativeRecordingImporter {
  private opening?: Promise<{ transcription: InferenceSession<"recording-transcription">; score: InferenceSession<"midi-to-score"> }>;
  private busy = false;
  private readonly backend: InferenceBackend;
  private readonly progress: (value: DownloadProgress) => void;
  private readonly stage: (value: string) => void;
  private readonly decode: typeof decodeAudioFile;

  constructor(backend: InferenceBackend, progress: (value: DownloadProgress) => void,
    stage: (value: string) => void, decode = decodeAudioFile) {
    this.backend = backend; this.progress = progress; this.stage = stage; this.decode = decode;
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.sessions(signal);
    signal?.throwIfAborted();
  }

  async run(data: ArrayBuffer, signal?: AbortSignal): Promise<{ musicXml: string; notes: PianoNote[] }> {
    if (this.busy) throw new Error("Recording import is already running");
    signal?.throwIfAborted();
    this.busy = true;
    try {
      this.stage("Opening the recording");
      const [sessions, decoded] = await Promise.all([this.sessions(signal), this.decode(data)]);
      signal?.throwIfAborted();
      this.stage("Finding the notes");
      const { notes } = await sessions.transcription.run({ audio: decoded.audio, sampleRate: 44100 }, signal);
      this.stage("Writing the score");
      const { musicXml } = await sessions.score.run({ notes }, signal);
      return { musicXml, notes };
    } finally { this.busy = false; }
  }

  private sessions(signal?: AbortSignal) {
    if (!this.opening) this.opening = this.backend.createSession("recording-transcription", this.progress, signal).then(async (transcription) => {
      try {
        const score = await this.backend.createSession("midi-to-score", this.progress, signal);
        return { transcription, score };
      } catch (error) { await transcription.close(); throw error; }
    }).catch((error: unknown) => { this.opening = undefined; throw error; });
    return this.opening;
  }
}
