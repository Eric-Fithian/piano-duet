import * as ort from "onnxruntime-web/webgpu";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { decodeRecordingOutputs } from "./recording-runtime";
import { RECORDING_FRAMES, RECORDING_WINDOW } from "../../../src/core/recording-segments.ts";

type Request = { id: number; action: "open"; features: ArrayBuffer; attributes: ArrayBuffer; threads: number }
  | { id: number; action: "compute"; frames: ArrayBuffer }
  | { id: number; action: "decode"; positions: number[] }
  | { id: number; action: "close" };
let features: ort.InferenceSession | undefined;
let attributes: ort.InferenceSession | undefined;
let current: Record<string, ort.Tensor> | undefined;

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    let value: unknown;
    if (data.action === "open") {
      ort.env.wasm.numThreads = data.threads;
      ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.origin).href,
        mjs: new URL(wasmModuleUrl, self.location.origin).href };
      features = await ort.InferenceSession.create(data.features, { executionProviders: ["wasm"] });
      attributes = await ort.InferenceSession.create(data.attributes, { executionProviders: ["wasm"] });
      value = { provider: "wasm", threads: data.threads };
    } else if (data.action === "compute") {
      if (!features || current) throw new Error("Recording worker is not ready for a segment");
      const input = new ort.Tensor("float32", new Float32Array(data.frames), [1, 1, RECORDING_FRAMES, RECORDING_WINDOW]);
      current = await features.run({ frames: input });
      input.dispose();
    } else if (data.action === "decode") {
      if (!attributes || !current) throw new Error("Recording worker has no segment to decode");
      const result = await decodeRecordingOutputs(current, attributes, data.positions);
      value = result.decoded;
      for (const tensor of Object.values(current)) tensor.dispose();
      current = undefined;
    } else {
      if (current) throw new Error("Recording worker still has a pending segment");
      await features?.release();
      await attributes?.release();
    }
    self.postMessage({ id: data.id, value });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
