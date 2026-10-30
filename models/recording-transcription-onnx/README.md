---
license: mit
library_name: onnx
tags:
  - audio
  - piano-transcription
  - onnx
---

# Piano Duet recording transcription ONNX

This prepared model card describes a conversion of [Transkun 2.0](https://github.com/Yujia-Yan/Transkun), by Yujia Yan and Zhiyao Duan, for local piano-recording transcription. The Python reference uses the `2.0.pt` checkpoint packaged with `transkun==2.0.1` and 44.1 kHz mono audio.

An FP32 feature graph and interval-attribute graph have been exported locally, with the interval decoder and segment stitching implemented in TypeScript. A three-minute repeated real-piano fixture matched all 960 reference onsets within 30 ms on browser WASM; broader recordings, quantization, final file digests and release validation remain outstanding. This card does not claim that a model release exists. The upstream repository and package include the MIT license reproduced in `LICENSE`. Please retain that notice with the converted files. See [Scoring Intervals Using Non-hierarchical Transformer for Automatic Piano Transcription](https://arxiv.org/abs/2404.09466) for the method.
