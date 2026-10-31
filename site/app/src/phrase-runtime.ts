import * as ort from "onnxruntime-web/webgpu";
import { decodePhrase } from "../../../src/core/phrase-transcription.ts";
import { roundEven } from "../../../src/core/numeric.ts";
import type { ModelInputs, ModelOutputs } from "./inference";

const WINDOW = 160000, HOP = 80000, CONTEXT = 4000;
const outputs = ["reg_onset", "reg_offset", "frame", "velocity", "pedal_offset", "pedal_frame"] as const;
type OutputName = typeof outputs[number];
type Chunk = Record<OutputName, Float32Array>;

export async function transcribePhrase(session: ort.InferenceSession, recurrent: ort.InferenceSession | undefined, input: ModelInputs["phrase-transcription"],
  signal: AbortSignal): Promise<ModelOutputs["phrase-transcription"]> {
  const { audio, sampleRate, threshold } = input;
  if (sampleRate !== 16000 || audio.length < 1600 || audio.some((sample) => !Number.isFinite(sample))
      || !Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.99) throw new Error("Phrase transcription needs finite 16 kHz mono audio");
  const padded = new Float32Array(audio.length + CONTEXT * 2);
  padded.set(audio, CONTEXT);
  const chunks: Chunk[] = [];
  for (let start = 0; start < Math.max(1, padded.length - HOP); start += HOP) {
    signal.throwIfAborted();
    const window = new Float32Array(WINDOW);
    window.set(padded.subarray(start, start + WINDOW));
    const tensor = new ort.Tensor("float32", window, [1, WINDOW]);
    const intermediate = recurrent ? await session.run({ [session.inputNames[0]]: tensor }) : null;
    const result = await (recurrent ?? session).run(intermediate ?? { [session.inputNames[0]]: tensor }, [...outputs]);
    const left = start === 0 ? 0 : 250, right = start + WINDOW >= padded.length ? 1000 : 750;
    const chunk = {} as Chunk;
    for (const name of outputs) {
      const item = result[name], channels = name.startsWith("pedal_") ? 1 : 88;
      if (!item || item.type !== "float32" || item.dims.length !== 3 || item.dims[0] !== 1
          || item.dims[1] !== 1001 || item.dims[2] !== channels) throw new Error(`Unexpected phrase transcription output ${name}`);
      chunk[name] = (item.data as Float32Array).slice(left * channels, right * channels);
      item.dispose();
    }
    for (const value of Object.values(intermediate ?? {})) value.dispose();
    tensor.dispose();
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  const frames = Math.min(roundEven(padded.length / 160), chunks.reduce((sum, chunk) => sum + chunk.frame.length / 88, 0));
  const join = (name: OutputName, channels: number): Float32Array => {
    const joined = new Float32Array(frames * channels);
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk[name].subarray(0, joined.length - offset);
      joined.set(part, offset); offset += part.length;
    }
    if (offset !== joined.length) throw new Error(`Phrase transcription omitted ${name} frames`);
    return joined;
  };
  return decodePhrase({ frames, onset: join("reg_onset", 88), offset: join("reg_offset", 88), frame: join("frame", 88),
    velocity: join("velocity", 88), pedalOffset: join("pedal_offset", 1), pedalFrame: join("pedal_frame", 1) }, threshold, audio.length / sampleRate);
}
