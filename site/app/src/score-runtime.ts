import * as ort from "onnxruntime-web/webgpu";
import type { ScoreInputTokens } from "../../../src/core/score-input.ts";

const INPUTS = { offset: 145, downbeat: 146, duration: 97, pitch: 128, accidental: 7, keysignature: 16,
  grace: 2, trill: 2, staccato: 2, voice: 9, stem: 4, hand: 3 };
const ORDER = ["offset", "downbeat", "duration", "pitch", "accidental", "keysignature", "velocity", "grace", "trill", "staccato", "voice", "stem", "hand", "pad"];
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const CACHES = Array.from({ length: 8 }, (_, index) => ["self_key", "self_value", "cross_key", "cross_value"]
  .map((kind) => `${kind}_${index}`)).flat();

export type ScoreGraphs = { encoder: ArrayBuffer | string; first: ArrayBuffer | string; context: ArrayBuffer | string; step: ArrayBuffer | string };
export type ScoreTokens = Record<string, number[]>;
export type ScoreProgress = { phase: "encoder" | "decoder"; chunk: number; completed: number; total: number };

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

function contextInput(history: ScoreTokens): Record<string, ort.Tensor> {
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

export class ScoreRuntime {
  private constructor(encoder: ort.InferenceSession, first: ort.InferenceSession,
    context: ort.InferenceSession, step: ort.InferenceSession) {
    this.encoder = encoder; this.first = first; this.context = context; this.step = step;
  }

  private encoder: ort.InferenceSession;
  private first: ort.InferenceSession;
  private context: ort.InferenceSession;
  private step: ort.InferenceSession;

  static async open(graphs: ScoreGraphs, provider: "webgpu" | "wasm",
    createSession: (graph: ArrayBuffer | string, options: ort.InferenceSession.SessionOptions) => Promise<ort.InferenceSession>
      = (graph, options) => typeof graph === "string" ? ort.InferenceSession.create(graph, options)
        : ort.InferenceSession.create(graph, options)): Promise<ScoreRuntime> {
    const executionProviders = provider === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
    const outputs = Object.fromEntries(CACHES.map((name) => [`present_${name}`, "gpu-buffer"])) as Record<string, "gpu-buffer">;
    const opened: ort.InferenceSession[] = [];
    const create = async (graph: ArrayBuffer | string, options: ort.InferenceSession.SessionOptions) => {
      const session = await createSession(graph, options); opened.push(session); return session;
    };
    try {
      const encoder = await create(graphs.encoder, { executionProviders,
        ...(provider === "webgpu" ? { preferredOutputLocation: { encoded: "gpu-buffer" } } : {}) });
      const options = { executionProviders, ...(provider === "webgpu" ? { preferredOutputLocation: outputs } : {}) };
      const first = await create(graphs.first, options);
      const context = await create(graphs.context, options);
      const step = await create(graphs.step, options);
      return new ScoreRuntime(encoder, first, context, step);
    } catch (error) {
      const released = await Promise.allSettled(opened.map((session) => Promise.resolve().then(() => session.release())));
      const failures = released.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length) throw new AggregateError([error, ...failures], "Score model initialization and cleanup failed");
      if (provider !== "webgpu") throw error;
      const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error });
      failure.name = "WebGPUInitializationError";
      if (error instanceof Error && error.stack) failure.stack = error.stack;
      throw failure;
    }
  }

  async generate(initial: ScoreInputTokens, signal?: AbortSignal, complete?: Promise<ScoreInputTokens>,
    progress?: (value: ScoreProgress) => void): Promise<ScoreTokens> {
    let sourceTokens = initial, n = initial.pad.length;
    if (!n) throw new Error("Score writing needs at least one note");
    const result: ScoreTokens = Object.fromEntries(ORDER.map((name) => [name, []]));
    let chunks = 0;
    for (let from = 0; from < Math.max(n - 64, 1); from += 448) {
      signal?.throwIfAborted();
      const length = Math.min(512, n - from), source: Record<string, ort.Tensor> = {};
      for (const [name, width] of Object.entries({ onset: 200, duration: 200, pitch: 128, velocity: 8 })) {
        const values = new Float32Array(length * width), stream = sourceTokens[name as keyof ScoreInputTokens];
        for (let index = 0; index < length; index++) values[index * width + stream[from + index]] = 1;
        source[name] = new ort.Tensor("float32", values, [1, length, width]);
      }
      source.pad = new ort.Tensor("int64", BigInt64Array.from(sourceTokens.pad.slice(from, from + length).map(BigInt)), [1, length]);
      progress?.({ phase: "encoder", chunk: chunks, completed: 0, total: 1 });
      const encoded = (await this.encoder.run(source)).encoded;
      progress?.({ phase: "encoder", chunk: chunks, completed: 1, total: 1 });
      let cache: Record<string, ort.Tensor> = {}, token: Record<string, ort.Tensor>, previousOffset = 0;
      if (chunks) {
        const initialContext = contextInput(result);
        const seeded = await this.context.run({ encoder: encoded, encoder_pad: source.pad, ...initialContext }, CACHES.map((name) => `present_${name}`));
        for (const value of Object.values(initialContext)) value.dispose();
        cache = Object.fromEntries(CACHES.map((name) => [`past_${name}`, seeded[`present_${name}`]]));
        const last = Object.fromEntries(ORDER.map((name) => [name, result[name].at(-1)!]));
        previousOffset = last.offset; token = tokenInput(last, last.pad);
      } else token = tokenInput({}, 0);
      const count = chunks ? 448 : 512;
      progress?.({ phase: "decoder", chunk: chunks, completed: 0, total: count });
      for (let position = 0; position < count; position++) {
        signal?.throwIfAborted();
        const isFirst = chunks === 0 && position === 0;
        const fetches = [...ORDER.map((name) => `out_${name}`), ...CACHES.filter((name) => isFirst || name.startsWith("self"))
          .map((name) => `present_${name}`)];
        const observed = await (isFirst ? this.first : this.step).run({ encoder: encoded, encoder_pad: source.pad, ...token, ...cache }, fetches);
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
          cache[`past_${name}`]?.dispose(); cache[`past_${name}`] = output;
        }
        for (const name of ORDER) observed[`out_${name}`].dispose();
        progress?.({ phase: "decoder", chunk: chunks, completed: position + 1, total: count });
      }
      for (const value of [...Object.values(token), ...Object.values(cache), ...Object.values(source), encoded]) value.dispose();
      chunks++;
      if (complete && chunks === 1) {
        const all = await complete;
        for (const name of Object.keys(all) as (keyof ScoreInputTokens)[]) {
          if (sourceTokens[name].slice(0, Math.min(512, n)).some((value, index) => value !== all[name][index])) {
            throw new Error("The completed transcription changed the first score input chunk");
          }
        }
        sourceTokens = all; n = all.pad.length;
      }
    }
    return result;
  }

  async close(): Promise<void> {
    await Promise.all([this.encoder.release(), this.first.release(), this.context.release(), this.step.release()]);
  }
}
