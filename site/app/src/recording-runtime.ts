import * as ort from "onnxruntime-web/webgpu";
import { decodeRecordingIntervals } from "../../../src/core/recording-intervals.ts";
import type { RecordingInterval } from "../../../src/core/recording-intervals.ts";
import { intervalEndpoints, recordingEvents, recordingFrames, RecordingAssembler, RECORDING_CONTEXT, RECORDING_FRAMES,
  RECORDING_PAD, RECORDING_STEP, RECORDING_TRACKS, RECORDING_WINDOW } from "../../../src/core/recording-segments.ts";
import type { PianoNote } from "./inference";

export interface RecordingTrace {
  segment: number;
  positions: number[];
  paths: RecordingInterval[][];
  result: ReturnType<typeof recordingEvents>;
}

export async function decodeRecordingOutputs(result: Record<string, ort.Tensor>, attributes: ort.InferenceSession,
  positions: number[]): Promise<{ paths: RecordingInterval[][]; decoded: ReturnType<typeof recordingEvents> }> {
  const context = result.context, score = result.score, skip = result.skip;
  if (!context || !score || !skip || context.type !== "float32" || score.type !== "float32" || skip.type !== "float32"
      || context.dims.join(",") !== `1,${RECORDING_TRACKS},${RECORDING_FRAMES},${RECORDING_CONTEXT}`
      || score.dims.join(",") !== `${RECORDING_FRAMES},${RECORDING_FRAMES},1,${RECORDING_TRACKS}`
      || skip.dims.join(",") !== `${RECORDING_FRAMES - 1},1,${RECORDING_TRACKS}`) throw new Error("Unexpected recording transcription outputs");
  const paths = decodeRecordingIntervals(score.data as Float32Array, skip.data as Float32Array, RECORDING_FRAMES, RECORDING_TRACKS, positions);
  const count = paths.reduce((sum, path) => sum + path.length, 0);
  let velocity = new Float32Array(0), timing = new Float32Array(0);
  if (count) {
    const endpoints = intervalEndpoints(context.data as Float32Array, paths, RECORDING_FRAMES);
    const start = new ort.Tensor("float32", endpoints.start, [count, RECORDING_CONTEXT]);
    const end = new ort.Tensor("float32", endpoints.end, [count, RECORDING_CONTEXT]);
    const predicted = await attributes.run({ start, end });
    try {
      if (!predicted.velocity || !predicted.timing || predicted.velocity.type !== "float32" || predicted.timing.type !== "float32") {
        throw new Error("Unexpected recording attribute outputs");
      }
      velocity = (predicted.velocity.data as Float32Array).slice();
      timing = (predicted.timing.data as Float32Array).slice();
    } finally {
      start.dispose(); end.dispose();
      for (const value of Object.values(predicted)) value.dispose();
    }
  }
  return { paths, decoded: recordingEvents(paths, velocity, timing) };
}

export async function transcribeRecording(features: ort.InferenceSession, attributes: ort.InferenceSession,
  audio: Float32Array, signal: AbortSignal, trace?: (entry: RecordingTrace) => void): Promise<PianoNote[]> {
  if (!audio.length || audio.some((sample) => !Number.isFinite(sample))) throw new Error("Recording transcription needs finite audio");
  const assembly = new RecordingAssembler(audio.length);
  for (let segment = 0; segment < audio.length + 2 * RECORDING_PAD; segment += RECORDING_STEP) {
    signal.throwIfAborted();
    const input = new ort.Tensor("float32", recordingFrames(audio, segment), [1, 1, RECORDING_FRAMES, RECORDING_WINDOW]);
    const result = await features.run({ frames: input });
    try {
      const { paths, decoded } = await decodeRecordingOutputs(result, attributes, assembly.positions);
      trace?.({ segment, positions: assembly.positions, paths, result: decoded });
      assembly.accept(segment, decoded);
    } finally {
      input.dispose();
      for (const value of Object.values(result)) value.dispose();
    }
  }
  signal.throwIfAborted();
  return assembly.finish();
}
