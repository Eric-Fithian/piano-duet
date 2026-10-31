---
license: cc-by-4.0
library_name: onnx
tags:
  - audio
  - piano-transcription
  - onnx
---

# Piano Duet live piano transcription ONNX

This is a live-inference adaptation of the high-resolution piano transcription model by Qiuqiang Kong and collaborators. The original checkpoint was published by Qiuqiang Kong on [Zenodo, DOI 10.5281/zenodo.4034264](https://doi.org/10.5281/zenodo.4034264), under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The starting ONNX graph is [stelee/piano-transcription-onnx](https://huggingface.co/stelee/piano-transcription-onnx), revision `24c14424609da2cc2c4b16d051365904327dd242`.

The live FP32 graphs accept two seconds of mono 16 kHz audio and retain the onset, frame and velocity outputs. `graph.onnx` is the pruned graph for WASM; `convolution.onnx` and `recurrent.onnx` partition it for WebGPU and WebAssembly execution.

The full-phrase FP32 graphs accept ten-second windows. `phrase-convolution.onnx` and `phrase-recurrent.onnx` partition the original graph at 18 recurrent inputs, retaining note onset, offset, frame and velocity and pedal offset and frame outputs. The unused pedal-onset head is omitted. Run the convolution graph on WebGPU and the recurrent graph on WASM, with graph optimization disabled, then apply the reference post-processor. These graphs were prepared with ONNX 1.23.2 and ONNX Runtime 1.30.0. Quantization and broader recorded-performance parity remain to be tested.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `graph.onnx` | 98697216 | `255a4e5e2c34fd09e3df19a93d246a534854d609ca72e5e650a18373b5a3f843` |
| `convolution.onnx` | 47604906 | `c84cad71a2990cb5b4cdf5602a0f115d722361948c064378d8970755753cc8a7` |
| `recurrent.onnx` | 51123832 | `a8df05a2f3c1434a53f3c2a4414af9830fff8dba48c9e7c5415ff746e1101419` |
| `phrase-convolution.onnx` | 62546926 | `67d33234b5f8fbabf1a21d99ed4d1e78c113b8e303d11702112b3705f8a51eed` |
| `phrase-recurrent.onnx` | 73207631 | `332c9050ec69b554e47de5f0a9c047cf709a9caa1cae3ad9ba62364e7d8b5892` |

The checkpoint has been modified by conversion to ONNX and by pruning and splitting its graph. The accompanying `LICENSE` contains the CC BY 4.0 legal text. The separate [inference package](https://pypi.org/project/piano-transcription-inference/) declares the MIT license for its code. The method is described in [High-resolution Piano Transcription with Pedals by Regressing Onset and Offset Times](https://arxiv.org/abs/2010.01815).
