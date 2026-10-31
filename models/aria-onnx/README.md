---
license: apache-2.0
library_name: onnx
tags:
  - music
  - piano
  - onnx
---

# Piano Duet Aria ONNX

This is a browser conversion of [Aria](https://github.com/EleutherAI/aria), by Louis Bradshaw and collaborators. It uses the generation checkpoint `model-gen.safetensors` from [loubb/aria-medium-base](https://huggingface.co/loubb/aria-medium-base) at revision `5a1ef36c5007ee10fbe57d61d96725a7244bd2b2`.

The 16-layer model is exported to ONNX with explicit key/value cache inputs and outputs, then quantized with asymmetric four-bit, block-64 weights. The graph was produced using PyTorch 2.14.1, ONNX 1.23.2 and ONNX Runtime 1.30.0. Keep the external data file alongside the graph.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `model.onnx` | 257414 | `08f7a2be505e9439ed07d5f2dd4627f8ab0907d1c72b9c2992fdf7dbd387bf2a` |
| `model.onnx.data` | 469306260 | `62251bfb6249f90fc47d7b9286f812181094a64342ea7fe5aa8a40c129542fc4` |

Aria's source and checkpoint are distributed under Apache License 2.0. The accompanying `LICENSE` is from the Aria source repository. Please also retain any upstream notices that accompany the released checkpoint. See the [Aria paper](https://arxiv.org/abs/2506.23869) and the upstream model card for training and use limitations.

Piano Duet runs the model locally. The prototype's measured masked-distribution comparison and its limitations are described in the project's [performance notes](https://piano-duet.vercel.app/docs/how/performance/).
