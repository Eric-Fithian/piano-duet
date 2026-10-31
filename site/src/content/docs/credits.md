---
title: Credits
description: The models, samples and libraries Piano Duet is built on.
---

Piano Duet is [MIT-licensed](https://github.com/Eric-Fithian/piano-duet/blob/main/LICENSE). Its models, samples and libraries each keep their own licenses. The Python app downloads its assets during setup; the browser build bundles VexFlow and downloads the piano samples when needed.

- [Aria paper and official implementation](https://github.com/EleutherAI/aria), Apache 2.0. [Generation checkpoint](https://huggingface.co/loubb/aria-medium-base/tree/5a1ef36c5007ee10fbe57d61d96725a7244bd2b2), `model-gen.safetensors`; [Piano Duet ONNX conversion](https://huggingface.co/ericfithian/piano-duet-aria-onnx). The upstream README's separate `aria-medium-gen` URL is unavailable; the author's base repository contains the generation-tuned weights.
- [Transkun](https://github.com/Yujia-Yan/Transkun), MIT; [Piano Duet ONNX conversion](https://huggingface.co/ericfithian/piano-duet-recording-transcription-onnx).
- High-resolution Piano Transcription by Qiuqiang Kong and collaborators: the [original checkpoint](https://doi.org/10.5281/zenodo.4034264) is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The [ONNX conversion by stelee](https://huggingface.co/stelee/piano-transcription-onnx) and [Piano Duet's pruned, split graph](https://huggingface.co/ericfithian/piano-duet-live-transcription-onnx) modify that checkpoint. The separate [inference package](https://pypi.org/project/piano-transcription-inference/) declares MIT for its code.
- Piano samples: [tonejs-instruments by Nicholaus P. Brosowsky](https://github.com/nbrosowsky/tonejs-instruments), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Samples are pitch-shifted and shaped with note envelopes for playback.
- Sheet music: [VexFlow 5.0.0](https://github.com/vexflow/vexflow), MIT. The Python setup preserves its license in `.cache/notation/LICENSE`.
- Key-profile reference: [Krumhansl–Kessler profiles in music21's documentation](https://music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html). The app combines these with scale coverage for the current phrase; music21 is not a runtime dependency.
- Interaction inspiration: [A.I. Duet](https://github.com/googlecreativelab/aiexperiments-ai-duet), by Yotam Mann with Google's Magenta and Creative Lab teams. This app is independent and does not reuse the old application code.
- Score writing: [MIDI2ScoreTransformer](https://github.com/TimFelixBeyer/MIDI2ScoreTransformer) (Beyer & Dai, ISMIR 2024). Its repository has no license file. The Python reference downloads its public checkpoint for local use. The browser version will not redistribute the public or retrained checkpoints without the author's permission; the GitHub release asset is not directly usable for browser downloads because it lacks CORS access. A user-supplied local checkpoint and on-device conversion are possible alternatives, but are not implemented yet.
- Recordings: [yt-dlp](https://github.com/yt-dlp/yt-dlp), Unlicense, and ffmpeg via [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg). Downloading from YouTube may conflict with its terms, so use it for personal practice.
- Practice material: drill choices follow the ABRSM, RCM and Trinity syllabi and Hanon. Dotted-rhythm and accent variations come from Graham Fitch and Piano Marvel.
