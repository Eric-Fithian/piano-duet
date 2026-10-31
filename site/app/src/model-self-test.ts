import pianoFixtureUrl from "./self-test-piano.f32?url";
import { acquireModelLock } from "./model-lock";
import { PIANO_SAMPLES, SAMPLE_REVISION } from "./piano-samples";
import type { AssetId, DownloadProgress, InferenceBackend, InferenceBackendRecord, ModelId, ModelInputs, ModelOutputs } from "./inference";
import type { ModelStore } from "./model-store";

export type ModelTestResult = { passed: boolean; text: string; backend?: InferenceBackendRecord };

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function pianoInput(): Promise<Float32Array> {
  const response = await fetch(pianoFixtureUrl);
  if (!response.ok) throw new Error(`Could not load test audio: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== 32000 * 4) throw new Error("The test audio has an unexpected length");
  const view = new DataView(buffer);
  return Float32Array.from({ length: 32000 }, (_, index) => view.getFloat32(index * 4, true));
}

function compareNotes(notes: { pitch: number; start: number }[], starts: number[]): void {
  check(notes.length === 3, `Expected three notes, got ${notes.length}`);
  for (let i = 0; i < 3; i++) {
    check(notes[i].pitch === [60, 63, 66][i] && Math.abs(notes[i].start - starts[i]) < 0.04,
      `Note ${i + 1} differs from the reference: pitch ${notes[i].pitch}, time ${notes[i].start}`);
  }
}

function compare<K extends ModelId>(model: K, output: ModelOutputs[K]): void {
  if (model === "aria") {
    const logits = (output as ModelOutputs["aria"]).logits;
    const expected = [[1035, 10.5109], [918, 10.3745], [879, 9.6760], [1034, 9.4982], [917, 9.1668]];
    check(logits.length === 17727, `Expected 17727 Aria logits, got ${logits.length}`);
    for (const [index, value] of expected) check(Number.isFinite(logits[index]) && Math.abs(logits[index] - value) < 0.4,
      `Aria logit ${index} differs from the reference: ${logits[index]}`);
  } else if (model === "midi-to-score") {
    const xml = (output as ModelOutputs["midi-to-score"]).musicXml;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const pitches = [...doc.querySelectorAll("pitch")].map((pitch) => `${pitch.querySelector("step")?.textContent}${pitch.querySelector("octave")?.textContent}`);
    check(pitches.join(",") === "C4,E4,G4,G4", `Score notes differ from the reference: ${pitches.join(", ")}`);
    const durations = [...doc.querySelectorAll("note")].filter((note) => note.querySelector("pitch"))
      .map((note) => note.querySelector("duration")?.textContent);
    check(durations.join(",") === "12,12,12,12", `Score durations differ from the reference: ${durations.join(", ")}`);
  } else {
    const notes = (output as ModelOutputs["live-transcription"]).notes;
    compareNotes(notes, model === "recording-transcription" ? [0.3284, 0.8242, 1.3281] : [0.3329, 0.8258, 1.3265]);
  }
}

export async function testModel(id: AssetId, backend: InferenceBackend, store: Pick<ModelStore, "get">, signal: AbortSignal,
  progress: (value: DownloadProgress) => void, reportBackend: (record: InferenceBackendRecord) => void = () => {}): Promise<ModelTestResult> {
  if (id === "piano-samples") {
    const release = await acquireModelLock(id, signal);
    const start = performance.now();
    try {
      const sample = PIANO_SAMPLES.find((item) => item.file === "C4.mp3");
      if (!sample) throw new Error("The C4 sample is missing from the catalog");
      const file = { model: id, name: sample.file, revision: SAMPLE_REVISION,
        url: `https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/${SAMPLE_REVISION}/samples/piano/${sample.file}`,
        bytes: sample.bytes, sha256: sample.sha256 };
      const response = await store.get(file, progress, signal);
      const bytes = await response.arrayBuffer();
      const loaded = performance.now();
      const audio = new AudioContext({ sampleRate: 16000 });
      try {
        const decoded = await audio.decodeAudioData(bytes);
        const data = decoded.getChannelData(0);
        const peak = data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
        check(Math.abs(decoded.duration - 9.97875) < 0.01 && Math.abs(peak - 0.701) < 0.03 && Math.abs(rms - 0.05324) < 0.003,
          `Piano sample differs from the reference: ${decoded.duration}s, peak ${peak}, RMS ${rms}`);
      } finally { await audio.close(); }
      return { passed: true, text: `Passed · audio decoder · load ${Math.round(loaded - start)} ms · test ${Math.round(performance.now() - loaded)} ms` };
    } finally { release(); }
  }
  const audio = id === "aria" || id === "midi-to-score" ? undefined : await pianoInput();
  const inputs: ModelInputs = {
    aria: { tokens: [6, 0, 827, 17227, 16766, 879, 17277, 16766, 918, 17327, 16766, 983, 17377, 16766], reset: true },
    "live-transcription": { audio: audio!, sampleRate: 16000, threshold: 0.8 },
    "phrase-transcription": { audio: audio!, sampleRate: 16000, threshold: 0.8 },
    "recording-transcription": { audio: audio!, sampleRate: 16000 },
    "midi-to-score": { notes: [60, 64, 67].map((pitch, index) => ({ pitch, start: index * 0.5, duration: 0.5, velocity: 90 })) },
  };
  const start = performance.now();
  const session = await backend.createSession(id, progress, signal);
  try {
    const loaded = performance.now();
    const record = { provider: session.provider, ...(session.fallback ? { fallback: { provider: session.fallback.provider, message: session.fallback.message } } : {}) };
    reportBackend(record);
    const label = record.provider === "webgpu" ? "WebGPU" : record.provider === "wasm" ? "WASM" : "Native";
    try {
      const output = await session.run(inputs[id], signal);
      const elapsed = performance.now() - loaded;
      compare(id, output);
      return { passed: true, backend: record, text: `Passed · ${label}${record.fallback ? ` (WebGPU: ${record.fallback.message})` : ""} · load ${Math.round(loaded - start)} ms · inference ${Math.round(elapsed)} ms` };
    } catch (error) {
      throw new Error(`${label} · load ${Math.round(loaded - start)} ms · inference ${Math.round(performance.now() - loaded)} ms: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  } finally { await session.close(); }
}
