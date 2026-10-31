import type { ModelAsset, ModelCatalog, ModelRole } from "./browser-inference.ts";
import type { ModelId } from "./inference.ts";

function asset(model: ModelId, repository: string, revision: string, role: ModelRole, name: string,
  bytes: number, sha256: string): ModelAsset {
  return { model, role, name, revision, bytes, sha256,
    url: `https://huggingface.co/ericfithian/${repository}/resolve/${revision}/${name}` };
}

const aria = "b44e0b4d4c4f04fba050d003f511080605a66199";
const live = "af9aad0409a25b7ebec9e09ac94013212c4d6dfc";
const recording = "8f6f1c1ee3b9e546679364f49c8b64a2c64a9b81";
const score = "c2bcbf58a22a2d23c2f9d1c7d5052bf9e85d757c";

export const MODEL_CATALOG: ModelCatalog = {
  aria: [
    asset("aria", "piano-duet-aria-onnx", aria, "graph", "model.onnx", 259238,
      "9a29ee51939f95bd54c8c4e97a1eb0fd09e7d18fe7041ec1989daeacf54762e9"),
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
  "phrase-transcription": [
    { model: "phrase-transcription", role: "graph", name: "piano_crnn.onnx", revision: "24c14424609da2cc2c4b16d051365904327dd242", bytes: 154206740,
      sha256: "743cf9fc88d1c24e5d4cc7a47ba55abd5c52c8623274355d79a981955fbbea99",
      url: "https://huggingface.co/stelee/piano-transcription-onnx/resolve/24c14424609da2cc2c4b16d051365904327dd242/piano_crnn.onnx" },
    asset("phrase-transcription", "piano-duet-live-transcription-onnx", "a9391f1876dffd1215b9f78de0429a7fa3a02e24", "convolution", "phrase-convolution.onnx", 62546926,
      "67d33234b5f8fbabf1a21d99ed4d1e78c113b8e303d11702112b3705f8a51eed"),
    asset("phrase-transcription", "piano-duet-live-transcription-onnx", "a9391f1876dffd1215b9f78de0429a7fa3a02e24", "recurrent", "phrase-recurrent.onnx", 73207631,
      "332c9050ec69b554e47de5f0a9c047cf709a9caa1cae3ad9ba62364e7d8b5892"),
  ],
  "recording-transcription": [
    asset("recording-transcription", "piano-duet-recording-transcription-onnx", recording, "features", "features.onnx", 53313300,
      "8c9d550d34662cd89d9271711cf59e5cd53820861e1f706c1766df3eb7388757"),
    asset("recording-transcription", "piano-duet-recording-transcription-onnx", recording, "attributes", "attributes.onnx", 3423800,
      "3c23a41616772ae9bc7a0b090558d09848d7e13f99607f5dc82629a5decfa29c"),
  ],
  "midi-to-score": [
    asset("midi-to-score", "piano-duet-score-onnx", score, "score-encoder", "encoder.onnx", 212157460,
      "12e7ac5576c6b35ad5565a26c481bc10248430bb674156228dcf7908030ab36e"),
    asset("midi-to-score", "piano-duet-score-onnx", score, "score-first", "decoder-first.onnx", 266641043,
      "26a3cb37064dbc2d2757c7e38c49d3d3d89c17d981a334c8cfb0c43ffdddaddf"),
    asset("midi-to-score", "piano-duet-score-onnx", score, "score-context", "decoder-context.onnx", 266702285,
      "2164ad2f6b783fc6871d0decd30277a433b63316b7f23ddbd2b188bcd3999fb5"),
    asset("midi-to-score", "piano-duet-score-onnx", score, "score-step", "decoder-step.onnx", 240273504,
      "b0f93af7317e8ca8233d7f2d1b33064d9b1e545c4bab74b08858cfc090afe9aa"),
  ],
};
