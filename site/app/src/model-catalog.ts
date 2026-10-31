import type { ModelAsset, ModelCatalog, ModelRole } from "./browser-inference";
import type { ModelId } from "./inference";

function asset(model: ModelId, repository: string, revision: string, role: ModelRole, name: string,
  bytes: number, sha256: string): ModelAsset {
  return { model, role, name, revision, bytes, sha256,
    url: `https://huggingface.co/ericfithian/${repository}/resolve/${revision}/${name}` };
}

const aria = "5ac00cdb1b9debed833784c17a27286b788533e7";
const live = "af9aad0409a25b7ebec9e09ac94013212c4d6dfc";
const recording = "8f6f1c1ee3b9e546679364f49c8b64a2c64a9b81";

export const MODEL_CATALOG: ModelCatalog = {
  aria: [
    asset("aria", "piano-duet-aria-onnx", aria, "graph", "model.onnx", 257414,
      "08f7a2be505e9439ed07d5f2dd4627f8ab0907d1c72b9c2992fdf7dbd387bf2a"),
    asset("aria", "piano-duet-aria-onnx", aria, "weights", "model.onnx.data", 469306260,
      "62251bfb6249f90fc47d7b9286f812181094a64342ea7fe5aa8a40c129542fc4"),
  ],
  "live-transcription": [
    asset("live-transcription", "piano-duet-live-transcription-onnx", live, "graph", "graph.onnx", 98697216,
      "255a4e5e2c34fd09e3df19a93d246a534854d609ca72e5e650a18373b5a3f843"),
    asset("live-transcription", "piano-duet-live-transcription-onnx", live, "convolution", "convolution.onnx", 47604906,
      "c84cad71a2990cb5b4cdf5602a0f115d722361948c064378d8970755753cc8a7"),
    asset("live-transcription", "piano-duet-live-transcription-onnx", live, "recurrent", "recurrent.onnx", 51123832,
      "a8df05a2f3c1434a53f3c2a4414af9830fff8dba48c9e7c5415ff746e1101419"),
  ],
  "recording-transcription": [
    asset("recording-transcription", "piano-duet-recording-transcription-onnx", recording, "features", "features.onnx", 53313300,
      "8c9d550d34662cd89d9271711cf59e5cd53820861e1f706c1766df3eb7388757"),
    asset("recording-transcription", "piano-duet-recording-transcription-onnx", recording, "attributes", "attributes.onnx", 3423800,
      "3c23a41616772ae9bc7a0b090558d09848d7e13f99607f5dc82629a5decfa29c"),
  ],
};
