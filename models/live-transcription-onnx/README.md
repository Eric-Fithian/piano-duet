---
license: cc-by-4.0
library_name: onnx
tags:
  - audio
  - piano-transcription
  - onnx
---

# Piano Duet live piano transcription ONNX

This prepared model card describes a live-inference adaptation of the high-resolution piano transcription model by Qiuqiang Kong and collaborators. The original checkpoint was published by Qiuqiang Kong on [Zenodo, DOI 10.5281/zenodo.4034264](https://doi.org/10.5281/zenodo.4034264), under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The starting ONNX graph is [stelee/piano-transcription-onnx](https://huggingface.co/stelee/piano-transcription-onnx), revision `24c14424609da2cc2c4b16d051365904327dd242`.

The prototype accepts two seconds of mono 16 kHz audio, retains the onset, frame and velocity outputs, and partitions the graph at the convolution/recurrent boundary for WebGPU and WebAssembly execution. Release artifacts, quantization, file digests and model parity on recorded performances still require validation; this card does not claim that a release exists.

The checkpoint has been modified by conversion to ONNX and, for the prototype, by pruning and splitting its graph. The accompanying `LICENSE` contains the CC BY 4.0 legal text. The separate [inference package](https://pypi.org/project/piano-transcription-inference/) declares the MIT license for its code. The method is described in [High-resolution Piano Transcription with Pedals by Regressing Onset and Offset Times](https://arxiv.org/abs/2010.01815).
