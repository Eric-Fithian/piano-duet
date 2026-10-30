---
license: apache-2.0
library_name: onnx
tags:
  - music
  - piano
  - onnx
---

# Piano Duet Aria ONNX

This prepared model card describes the planned browser conversion of [Aria](https://github.com/EleutherAI/aria), by Louis Bradshaw and collaborators. It uses the generation checkpoint `model-gen.safetensors` from [loubb/aria-medium-base](https://huggingface.co/loubb/aria-medium-base) at revision `5a1ef36c5007ee10fbe57d61d96725a7244bd2b2`.

The prototype exports the 16-layer model to ONNX with explicit key/value cache inputs and outputs, then applies asymmetric four-bit, block-64 weight quantization. The intended files are an ONNX graph and its external data file. The final release must record their SHA-256 digests, sizes, conversion tool versions and immutable repository revision after validation; this card is preparation and does not claim that a release exists.

Aria's source and checkpoint are distributed under Apache License 2.0. The accompanying `LICENSE` is from the Aria source repository. Please also retain any upstream notices that accompany the released checkpoint. See the [Aria paper](https://arxiv.org/abs/2506.23869) and the upstream model card for training and use limitations.

Piano Duet runs the model locally. The prototype's measured masked-distribution comparison and its limitations are described in the project's [performance notes](https://piano-duet.vercel.app/docs/how/performance/).
