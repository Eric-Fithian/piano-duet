---
license: mit
library_name: onnx
tags:
  - audio
  - piano-transcription
  - onnx
---

# Piano Duet recording transcription ONNX

This is a conversion of [Transkun 2.0](https://github.com/Yujia-Yan/Transkun), by Yujia Yan and Zhiyao Duan, for local piano-recording transcription. The Python reference uses the `2.0.pt` checkpoint packaged with `transkun==2.0.1` and 44.1 kHz mono audio.

The FP32 feature and interval-attribute graphs use PyTorch 2.14.1 and ONNX 1.23.2; the interval decoder and segment stitching are implemented in Piano Duet. A three-minute repeated real-piano fixture matched all 960 reference onsets within 30 ms on browser WASM. Broader recordings and quantization remain to be tested. The upstream repository and package include the MIT license reproduced in `LICENSE`. Please retain that notice with the converted files. See [Scoring Intervals Using Non-hierarchical Transformer for Automatic Piano Transcription](https://arxiv.org/abs/2404.09466) for the method.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `features.onnx` | 53313300 | `8c9d550d34662cd89d9271711cf59e5cd53820861e1f706c1766df3eb7388757` |
| `attributes.onnx` | 3423800 | `3c23a41616772ae9bc7a0b090558d09848d7e13f99607f5dc82629a5decfa29c` |
