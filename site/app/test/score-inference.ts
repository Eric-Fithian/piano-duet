import * as ort from "onnxruntime-web/webgpu";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { scoreInput } from "../../../src/core/score-input.ts";
import type { ScoreInputNote } from "../../../src/core/score-input.ts";
import { BrowserInference } from "../src/browser-inference";
import type { ModelAsset } from "../src/browser-inference";

const INPUTS = { offset: 145, downbeat: 146, duration: 97, pitch: 128, accidental: 7, keysignature: 16,
  grace: 2, trill: 2, staccato: 2, voice: 9, stem: 4, hand: 3 };
const ORDER = ["offset", "downbeat", "duration", "pitch", "accidental", "keysignature", "velocity", "grace", "trill", "staccato", "voice", "stem", "hand", "pad"];
const CACHES = Array.from({ length: 4 }, (_, index) => ["self_key", "self_value", "cross_key", "cross_value"].map((kind) => `${kind}_${index}`)).flat();
const WHITE = [0, 2, 4, 5, 7, 9, 11];
type Fixture = { source: Record<string, number[][][]> & { pad: number[][] }; expected: Record<string, number[]>; source_notes: number; reference_ms: number };

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

async function verifyScore(base: string, provider: "webgpu" | "wasm", notes?: ScoreInputNote[], includeTokens = false) {
    const response = await fetch(`${base}/fixtures/score-fixture.json`);
    if (!response.ok) throw new Error("Score fixture is unavailable");
    const fixture = await response.json() as Fixture;
    const outputs = Object.fromEntries(CACHES.map((name) => [`present_${name}`, "gpu-buffer"])) as Record<string, "gpu-buffer">;
    const executionProviders = provider === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
    const encoder = await ort.InferenceSession.create(`${base}/models/score/encoder.onnx`, { executionProviders,
      ...(provider === "webgpu" ? { preferredOutputLocation: { encoded: "gpu-buffer" } } : {}) });
    const options = { executionProviders, ...(provider === "webgpu" ? { preferredOutputLocation: outputs } : {}) };
    const first = await ort.InferenceSession.create(`${base}/models/score/decoder-first.onnx`, options);
    const context = await ort.InferenceSession.create(`${base}/models/score/decoder-context.onnx`, options);
    const step = await ort.InferenceSession.create(`${base}/models/score/decoder-step.onnx`, options);
    const converted = notes ? scoreInput(notes) : null;
    const n = converted ? converted.pad.length : fixture.source_notes;
    const inputDifferences = converted && n === fixture.source_notes ? Object.fromEntries(
      Object.entries({ onset: converted.onset, duration: converted.duration, pitch: converted.pitch, velocity: converted.velocity }).map(([name, values]) =>
        [name, values.reduce((sum, value, index) => sum + Number(value !== fixture.source[name][0][index].indexOf(1)), 0)])) : null;
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
    }
    const elapsedMs = performance.now() - started;
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
});
