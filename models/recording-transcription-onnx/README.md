---
license: mit
library_name: onnx
tags:
  - audio
  - piano-transcription
  - onnx
---

# Piano Duet recording transcription ONNX

This prepared model card describes a planned conversion of [Transkun 2.0](https://github.com/Yujia-Yan/Transkun), by Yujia Yan and Zhiyao Duan, for local piano-recording transcription. The current Python reference uses the `2.0.pt` checkpoint packaged with `transkun==2.0.1` and 44.1 kHz mono audio.

The ONNX conversion, quantization, decoding, file digests and parity measurements remain to be completed; this card does not claim that a model release exists. The upstream repository and package include the MIT license reproduced in `LICENSE`. Please retain that notice with the converted files. See [Scoring Intervals Using Non-hierarchical Transformer for Automatic Piano Transcription](https://arxiv.org/abs/2404.09466) for the method.
