import * as ort from "onnxruntime-web/webgpu";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { scoreInput } from "../../../src/core/score-input.ts";
import { scoreMusicXml } from "../../../src/core/score-output.ts";
import type { ScoreInputNote } from "../../../src/core/score-input.ts";
import { BrowserInference } from "../src/browser-inference";
import type { ModelAsset } from "../src/browser-inference";
import { RecordingPool } from "../src/recording-pool";
import { decodeAudioFile } from "../src/audio-decoder";
import { ScoreRuntime } from "../src/score-runtime";

const INPUTS = { offset: 145, downbeat: 146, duration: 97, pitch: 128, accidental: 7, keysignature: 16,
  grace: 2, trill: 2, staccato: 2, voice: 9, stem: 4, hand: 3 };
const ORDER = ["offset", "downbeat", "duration", "pitch", "accidental", "keysignature", "velocity", "grace", "trill", "staccato", "voice", "stem", "hand", "pad"];
const WHITE = [0, 2, 4, 5, 7, 9, 11];
type Fixture = { source: Record<string, number[][][]> & { pad: number[][] }; expected: Record<string, number[]>; source_notes: number; reference_ms: number; decoder_layers: number };

ort.env.wasm.numThreads = crossOriginIsolated ? navigator.hardwareConcurrency : 1;
ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, location.origin).href, mjs: new URL(wasmModuleUrl, location.origin).href };

function select(values: Float32Array, allowed: (index: number) => boolean = () => true): number {
  let result = -1, best = -Infinity;
  for (let index = 0; index < values.length; index++) {
    if (allowed(index) && values[index] > best) { result = index; best = values[index]; }
  }
  if (result < 0 || !Number.isFinite(best)) throw new Error("The score model returned invalid logits");
  return result;
}

function accidentalAllowed(index: number, pitch: number): boolean {
  const note = pitch % 12;
  if (index === 2 || index === 5) return WHITE.includes(note);
  if (index === 1) return WHITE.includes((note + 1) % 12);
  if (index === 3) return WHITE.includes((note + 11) % 12);
  return false;
}

function tokenInput(values: Record<string, number>, pad: number): Record<string, ort.Tensor> {
  const tokens: Record<string, ort.Tensor> = Object.fromEntries(Object.entries(INPUTS).map(([name, width]) => {
    const oneHot = new Float32Array(width);
    if (pad) oneHot[values[name]] = 1;
    return [`in_${name}`, new ort.Tensor("float32", oneHot, [1, 1, width])];
  }));
  tokens.in_pad = new ort.Tensor("int64", BigInt64Array.of(BigInt(pad)), [1, 1]);
  return tokens;
}

function contextInput(history: Record<string, number[]>): Record<string, ort.Tensor> {
  const offset = history.pad.length - 64;
  if (offset < 0) throw new Error("A score continuation needs 64 prior tokens");
  const tokens: Record<string, ort.Tensor> = Object.fromEntries(Object.entries(INPUTS).map(([name, width]) => {
    const oneHot = new Float32Array(64 * width);
    for (let index = 0; index < 63; index++) if (history.pad[offset + index]) oneHot[index * width + history[name][offset + index]] = 1;
    return [`in_${name}`, new ort.Tensor("float32", oneHot, [1, 64, width])];
  }));
  const pad = new BigInt64Array(64);
  for (let index = 0; index < 63; index++) pad[index] = BigInt(history.pad[offset + index]);
  tokens.in_pad = new ort.Tensor("int64", pad, [1, 64]);
  return tokens;
}

async function decodeRecordingFile(base: string): Promise<Float32Array> {
  const response = await fetch(`${base}/fixtures/recording.wav`);
  if (!response.ok) throw new Error("Recording file is unavailable");
  return (await decodeAudioFile(await response.arrayBuffer())).audio;
}

async function verifyScore(base: string, provider: "webgpu" | "wasm", notes?: ScoreInputNote[], includeTokens = false,
  streaming?: { first: Promise<ScoreInputNote[]>; complete: Promise<ScoreInputNote[]>; ready?: () => void; warm?: boolean }) {
    const response = await fetch(`${base}/fixtures/score-fixture.json`);
    if (!response.ok) throw new Error("Score fixture is unavailable");
    const fixture = await response.json() as Fixture;
    if (!Number.isInteger(fixture.decoder_layers) || fixture.decoder_layers < 1) throw new Error("Score fixture is missing its decoder layer count");
    const CACHES = Array.from({ length: fixture.decoder_layers }, (_, index) => ["self_key", "self_value", "cross_key", "cross_value"].map((kind) => `${kind}_${index}`)).flat();
    const outputs = Object.fromEntries(CACHES.map((name) => [`present_${name}`, "gpu-buffer"])) as Record<string, "gpu-buffer">;
    const executionProviders = provider === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
    const encoder = await ort.InferenceSession.create(`${base}/models/score/encoder.onnx`, { executionProviders,
      ...(provider === "webgpu" ? { preferredOutputLocation: { encoded: "gpu-buffer" } } : {}) });
    const options = { executionProviders, ...(provider === "webgpu" ? { preferredOutputLocation: outputs } : {}) };
    const first = await ort.InferenceSession.create(`${base}/models/score/decoder-first.onnx`, options);
    const context = await ort.InferenceSession.create(`${base}/models/score/decoder-context.onnx`, options);
    const step = await ort.InferenceSession.create(`${base}/models/score/decoder-step.onnx`, options);
    if (streaming?.warm) {
      const length = Math.min(512, fixture.source_notes), source: Record<string, ort.Tensor> = {};
      for (const [name, width] of Object.entries({ onset: 200, duration: 200, pitch: 128, velocity: 8 })) {
        source[name] = new ort.Tensor("float32", Float32Array.from(fixture.source[name][0].slice(0, length).flat()), [1, length, width]);
      }
      source.pad = new ort.Tensor("int64", BigInt64Array.from(fixture.source.pad[0].slice(0, length).map(BigInt)), [1, length]);
      const encoded = (await encoder.run(source)).encoded, initial = tokenInput({}, 0);
      const generated = await first.run({ encoder: encoded, encoder_pad: source.pad, ...initial });
      const cache = Object.fromEntries(CACHES.map((name) => [`past_${name}`, generated[`present_${name}`]]));
      const continued = await step.run({ encoder: encoded, encoder_pad: source.pad, ...initial, ...cache });
      const history = Object.fromEntries(ORDER.map((name) => [name, Array(64).fill(0)]));
      const contextTokens = contextInput(history);
      const seeded = await context.run({ encoder: encoded, encoder_pad: source.pad, ...contextTokens });
      for (const tensor of [...Object.values(source), ...Object.values(initial), ...Object.values(generated),
        ...Object.values(continued), ...Object.values(contextTokens), ...Object.values(seeded), encoded]) tensor.dispose();
    }
    streaming?.ready?.();
    let converted = streaming ? scoreInput(await streaming.first) : notes ? scoreInput(notes) : null;
    let n = converted ? converted.pad.length : fixture.source_notes;
    const result: Record<string, number[]> = Object.fromEntries(ORDER.map((name) => [name, []]));
    const started = performance.now();
    let chunks = 0;
    for (let from = 0; from < Math.max(n - 64, 1); from += 448) {
      const length = Math.min(512, n - from);
      const source: Record<string, ort.Tensor> = {};
      for (const [name, width] of Object.entries({ onset: 200, duration: 200, pitch: 128, velocity: 8 })) {
        const values = converted ? new Float32Array(length * width) : Float32Array.from(fixture.source[name][0].slice(from, from + length).flat());
        if (converted) for (let index = 0; index < length; index++) values[index * width + converted[name as keyof typeof converted][from + index]] = 1;
        source[name] = new ort.Tensor("float32", values, [1, length, width]);
      }
      const padding = converted ? converted.pad.slice(from, from + length) : fixture.source.pad[0].slice(from, from + length);
      source.pad = new ort.Tensor("int64", BigInt64Array.from(padding.map(BigInt)), [1, length]);
      const encoded = (await encoder.run(source)).encoded;
      let cache: Record<string, ort.Tensor> = {};
      let token: Record<string, ort.Tensor>;
      let previousOffset = 0;
      if (chunks) {
        const initial = contextInput(result);
        const seeded = await context.run({ encoder: encoded, encoder_pad: source.pad, ...initial }, CACHES.map((name) => `present_${name}`));
        for (const value of Object.values(initial)) value.dispose();
        cache = Object.fromEntries(CACHES.map((name) => [`past_${name}`, seeded[`present_${name}`]]));
        const last = Object.fromEntries(ORDER.map((name) => [name, result[name].at(-1)!]));
        previousOffset = last.offset;
        token = tokenInput(last, last.pad);
      } else token = tokenInput({}, 0);
      const count = chunks ? 448 : 512;
      for (let position = 0; position < count; position++) {
        const isFirst = chunks === 0 && position === 0;
        const fetches = [...ORDER.map((name) => `out_${name}`), ...CACHES.filter((name) => isFirst || name.startsWith("self"))
          .map((name) => `present_${name}`)];
        const observed = await (isFirst ? first : step).run({ encoder: encoded, encoder_pad: source.pad, ...token, ...cache }, fetches);
        const picked: Record<string, number> = {};
        for (const name of ORDER) {
          const tensor = observed[`out_${name}`];
          if (!tensor || tensor.type !== "float32") throw new Error(`Missing score output ${name}`);
          const values = tensor.data as Float32Array;
          if (name === "pad") picked[name] = Number(values[0] > 0);
          else if (name === "downbeat") picked[name] = select(values, (index) => !((chunks > 0 || position > 0) && picked.offset < previousOffset && index === 0));
          else if (name === "accidental") picked[name] = select(values, (index) => accidentalAllowed(index, picked.pitch));
          else picked[name] = select(values);
        }
        if (!picked.pad) for (const name of ORDER) if (name !== "pad") picked[name] = 0;
        previousOffset = picked.offset;
        for (const name of ORDER) result[name].push(picked[name]);
        for (const value of Object.values(token)) value.dispose();
        token = tokenInput(picked, picked.pad);
        for (const name of CACHES) {
          const output = observed[`present_${name}`];
          if (!output) continue;
          cache[`past_${name}`]?.dispose();
          cache[`past_${name}`] = output;
        }
        for (const name of ORDER) observed[`out_${name}`].dispose();
        if ((position + 1) % 128 === 0) console.log(`Score chunk ${chunks + 1}: ${position + 1}/${count}`);
      }
      for (const value of [...Object.values(token), ...Object.values(cache), ...Object.values(source), encoded]) value.dispose();
      chunks++;
      if (streaming && chunks === 1) {
        const complete = scoreInput(await streaming.complete);
        if (!converted || Object.keys(complete).some((name) => {
          const key = name as keyof typeof complete;
          return converted![key].slice(0, Math.min(512, n)).some((value, index) => value !== complete[key][index]);
        })) throw new Error("The completed transcription changed the first score input chunk");
        converted = complete;
        n = complete.pad.length;
      }
    }
    const elapsedMs = performance.now() - started;
    const inputDifferences = converted && n === fixture.source_notes ? Object.fromEntries(
      Object.entries({ onset: converted.onset, duration: converted.duration, pitch: converted.pitch, velocity: converted.velocity }).map(([name, values]) =>
        [name, values.reduce((sum, value, index) => sum + Number(value !== fixture.source[name][0][index].indexOf(1)), 0)])) : null;
    const mismatches = Object.fromEntries(ORDER.map((name) => {
      if (result[name].length !== fixture.expected[name].length) throw new Error(`Score length differs for ${name}`);
      return [name, result[name].reduce((sum, value, index) => sum + Number(value !== fixture.expected[name][index]), 0)];
    }));
    await Promise.all([encoder.release(), first.release(), context.release(), step.release()]);
    return { sourceNotes: n, chunks, elapsedMs, referenceMs: fixture.reference_ms, inputDifferences,
      valid: result.pad.reduce((sum, value) => sum + value, 0), referenceValid: fixture.expected.pad.reduce((sum, value) => sum + value, 0),
      mismatches, ...(includeTokens ? { tokens: result } : {}) };
}

Object.assign(window, {
  verifyScore,
  async verifyScoreRuntime(base: string, provider: "webgpu" | "wasm") {
    const response = await fetch(`${base}/fixtures/score-fixture.json`);
    if (!response.ok) throw new Error("Score fixture is unavailable");
    const fixture = await response.json() as Fixture;
    if (fixture.decoder_layers !== 8) throw new Error("The published score runtime expects eight decoder layers");
    const values = (name: string) => fixture.source[name][0].map((row) => row.indexOf(1));
    const streams = { onset: values("onset"), duration: values("duration"), pitch: values("pitch"),
      velocity: values("velocity"), pad: fixture.source.pad[0] };
    const model = await ScoreRuntime.open({ encoder: `${base}/models/score/encoder.onnx`, first: `${base}/models/score/decoder-first.onnx`,
      context: `${base}/models/score/decoder-context.onnx`, step: `${base}/models/score/decoder-step.onnx` }, provider);
    const started = performance.now();
    const tokens = await model.generate(streams);
    const mismatches = Object.fromEntries(ORDER.map((name) => {
      if (tokens[name].length !== fixture.expected[name].length) throw new Error(`Score length differs for ${name}`);
      return [name, tokens[name].reduce((sum, value, index) => sum + Number(value !== fixture.expected[name][index]), 0)];
    }));
    await model.close();
    return { sourceNotes: fixture.source_notes, elapsedMs: performance.now() - started, mismatches };
  },
  async verifyRecordingScore(base: string, assets: ModelAsset[]) {
    const response = await fetch(`${base}/fixtures/recording.pcm`);
    if (!response.ok) throw new Error("Recording fixture is unavailable");
    const audio = new Float32Array(await response.arrayBuffer());
    const backend = new BrowserInference({ "recording-transcription": assets });
    const session = await backend.createSession("recording-transcription", () => {});
    const started = performance.now();
    const recording = await session.run({ audio, sampleRate: 44100 });
    const transcriptionMs = performance.now() - started;
    const score = await verifyScore(base, "webgpu", recording.notes, true);
    const elapsedMs = performance.now() - started;
    await session.close();
    return { transcriptionMs, score, elapsedMs, recordingProvider: session.provider };
  },
  async verifyRecordingScoreOverlap(base: string, assets: ModelAsset[], workers = 4, full = false, cold = false) {
    const preparationStarted = performance.now();
    const audioPromise = full && cold ? decodeRecordingFile(base) : !full ? fetch(`${base}/fixtures/recording.pcm`).then(async (response) => {
      if (!response.ok) throw new Error("Recording fixture is unavailable");
      return new Float32Array(await response.arrayBuffer());
    }) : null;
    const buffers = await Promise.all(assets.map(async (asset) => {
      const result = await fetch(asset.url);
      if (!result.ok) throw new Error(`Could not load ${asset.name}`);
      return result.arrayBuffer();
    }));
    const pool = await RecordingPool.open(buffers[0], buffers[1], workers, 3);
    let resolveFirst!: (notes: ScoreInputNote[]) => void;
    let rejectFirst!: (error: unknown) => void;
    const first = new Promise<ScoreInputNote[]>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    let resolveComplete!: (notes: ScoreInputNote[]) => void;
    let rejectComplete!: (error: unknown) => void;
    const complete = new Promise<ScoreInputNote[]>((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const scoring = verifyScore(base, "webgpu", undefined, true, { first, complete, ready: resolveReady, warm: full && !cold });
    await Promise.race([ready, scoring.then(() => { throw new Error("Score completed before transcription began"); })]);
    if (full && !cold) await pool.run(new Float32Array(16 * 44100), new AbortController().signal);
    const initialized = performance.now(), started = full && cold ? preparationStarted : initialized;
    const decodeStarted = performance.now();
    const audio = await (audioPromise ?? decodeRecordingFile(base));
    const decoded = performance.now();
    let firstMs: number | undefined;
    const transcription = pool.run(audio, new AbortController().signal, (completed) => {
      if (firstMs === undefined && completed.length >= 512 && scoreInput(completed).pad.length >= 512) {
        firstMs = performance.now() - started;
        resolveFirst(completed);
      }
    });
    transcription.then((completed) => { if (firstMs === undefined) resolveFirst(completed); resolveComplete(completed); },
      (error) => { if (firstMs === undefined) rejectFirst(error); else rejectComplete(error); });
    const score = await scoring;
    const musicxml = full ? scoreMusicXml(score.tokens!) : undefined;
    const elapsedMs = performance.now() - started;
    pool.close();
    return { preparationMs: initialized - preparationStarted, decodeWaitMs: decoded - decodeStarted, firstMs, score, musicxml,
      elapsedMs, workers, threads: 3, recordingProvider: "wasm" };
  },
});
