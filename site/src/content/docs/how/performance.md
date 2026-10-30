---
title: Browser inference measurements
description: Measurements and limits of the local browser inference prototype.
---

These are feasibility measurements, not timings for a finished browser app. They were taken on an Apple M4 Pro with 24 GB of memory, macOS 27.0.1, headless Chrome 155 and ONNX Runtime Web 1.31.1. The models and audio stayed on the Mac. Safari and iPhone have not yet been measured.

| Measurement | Result | Method |
| --- | --- | --- |
| Aria prefill | 193 ms | 14 tokens; model already loaded |
| Aria decode | 34 ms/token median | 36 warmed single-token steps; WebGPU with KV outputs kept in GPU buffers |
| Aria masked sampling | ONNX mean KL 0.084, p95 0.525; MLX mean 0.511, p95 0.851 | 60 choices from five generated Reading scores and one Duet reply, compared with full-precision PyTorch |
| Live transcription | 81–88 ms per warmed window | 2 seconds at 16 kHz, convolution on WebGPU and recurrent layers on 12-thread WASM; transfer included |
| Reading feedback | 472–486 ms browser; 547–655 ms Python | Three trials each, same E4 score and synthetic microphone, measured from detected audio onset to a green score note |

The Aria comparison uses the app's actual allowed-token masks, weights, temperature and min-p cutoff. KL is in nats; probabilities removed by the cutoff are smoothed at `1e-12` so the comparison remains finite. Mean top-k overlap with the full-precision distribution was 0.9645 for ONNX and 0.9646 for MLX. The sampled contexts are generated exercises, not recorded performances; broader fixture coverage is still needed. The gate requires ONNX's mean and 95th-percentile KL to be no worse than MLX, and records regression caps at 1.1 times the MLX values.

The transcription fixture contains three sampled piano notes. The split graph's maximum onset-tensor difference from the Python reference was about `0.0000023`, and it detected the same three pitches. The full graph took roughly 1.03 seconds per window on WebGPU; pruning and splitting matters. A four-thread Python reference took roughly 125–158 ms per window in these measurements. An exploratory fp16 conversion clamped constants and changed onset values by as much as 0.409, so it is not the current candidate.

The Reading comparison uses the existing app's `ReadingStream` and score renderer. A local test proxy provides the cross-origin isolation needed for threaded WASM, and swaps only the transcription call. The sampled note is rendered into a synthetic microphone; no physical microphone was used. The browser application, iOS shell, account sync, download sizes and memory usage are not yet validated.

To reproduce the model measurements on a prepared Mac checkout, keep the existing model files and piano samples in `.cache`, then run:

```sh
npm ci
uv sync --frozen
uv run --frozen python -m piano_duet.aria_onnx
uv run --frozen python -m piano_duet.aria_quantize_onnx
uv run --frozen python -m piano_duet.aria_onnx_parity
uv run --frozen python -m piano_duet.aria_sampling_fixture
uv run --frozen python -m piano_duet.aria_sampling_parity
uv run --frozen python -m piano_duet.browser_inference_fixture
node tests/inference/measure-browser.mjs chrome aria webgpu
node tests/inference/measure-browser.mjs chrome transcription split-fp32
```

The full-model checks need local weights and are not yet part of CI. The small-model export and cache tests do run in CI. The paired Reading test also needs the reference app running on port 8879 with a separate learner database under `.cache/browser-inference/`; `tests/inference/reading-latency.mjs` never uses the existing learner database.
