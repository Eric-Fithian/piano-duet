---
title: Browser inference measurements
description: Measurements and limits of the local browser inference prototype.
---

These measurements cover an unfinished browser app; some time individual model stages and others exercise complete interface flows. Unless stated otherwise, they were taken on an Apple M4 Pro with 24 GB of memory, macOS 27.0.1, headless Chrome 155 and ONNX Runtime Web 1.31.1. The models and audio stayed on the Mac. An iPhone has not yet been measured.

| Measurement | Result | Method |
| --- | --- | --- |
| Aria prefill | 114 ms | 14 tokens; model already loaded; one run with the current graph |
| Aria decode | 15 ms/token median | 32 warmed single-token steps; WebGPU with KV outputs kept in GPU buffers; one run with the current graph |
| Aria masked sampling | ONNX mean KL 0.084, p95 0.525; MLX mean 0.511, p95 0.851 | 60 choices from five generated Reading scores and one Duet reply, compared with full-precision PyTorch |
| TypeScript Reading composition | 0.70 s first-notes score; 2.96 s dyad score | One seeded score per stage with the full Aria model on WebGPU, measured after model loading |
| Live transcription | 81–88 ms per warmed window | 2 seconds at 16 kHz, convolution on WebGPU and recurrent layers on 12-thread WASM; transfer included |
| Full-phrase transcription | 3.88 s WASM; 1.32 s split GPU/WASM; 1.34 s Python CPU | One 11.5-second synthetic phrase with six repeated piano attacks, including two 10-second inference windows; model sessions already open. The app uses the split where WebGPU is available and the original full graph for WASM fallback. |
| Reading feedback | 472–486 ms browser; 547–655 ms Python | Three trials each, same E4 score and synthetic microphone, measured from detected audio onset to a green score note |
| Recording transcription | 54.2 s with one 12-thread worker; 42.1 s with three 4-thread workers; 40.7 s with four 3-thread workers; 40.0 s with six 2-thread workers | Three-minute fixture made by repeating one minute of real piano audio; FP32 ONNX on WASM, model already loaded, including frame preparation, interval decoding, attributes and stitching |
| Recording onset parity | 960 of 960 notes matched | Same three-minute audio and 30 ms onset tolerance against the Python Transkun reference; maximum matched onset difference 19.8 ms, duration difference 22.9 ms and velocity difference 1 |
| Drill microphone and transcription | 9 of 9 notes matched | Simulated five-finger performance in Chrome, from fake microphone through automatic take ending, browser Transkun, saved assessment and results panel |
| Python score writing | 10.6 s | The same 960-note performance, using the local medium MIDI2ScoreTransformer checkpoint on CPU, including cold model loading; 898 score notes produced |
| Browser score-model prototype | 9.3 s | The 960-note performance tokenized by Python, using a local FP32 ONNX conversion of the public checkpoint on WebGPU; two overlapping chunks, model already loaded |
| Browser transcription through score tokens | 47.9 s | Same three-minute audio, four WASM transcription workers followed by WebGPU score decoding; includes score-session initialization, excludes initial transcription-model loading, audio decoding and MusicXML construction |
| Browser default score-model prototype | 14.3 s | The same 960 notes and local FP32 ONNX conversion of the 120M-parameter retrained checkpoint, WebGPU, two sequential chunks, model already loaded |
| Browser transcription through default score tokens | 56.0 s | Same three-minute audio, four WASM transcription workers followed by the 120M model on WebGPU; includes score-session initialization, excludes initial transcription-model loading, audio decoding and MusicXML construction |
| Overlapped transcription and default score tokens | 51.4 s (4 workers), 51.5 s (3 workers) | Same audio; score sessions initialized before transcription, first chunk starts after 512 stable notes; excludes initialization, audio decoding and MusicXML construction |
| WAV-to-MusicXML prototype | 54.8 s cold; 47.5 s warm | Same three-minute audio and four workers, including file reading, worker decoding, transcription, overlapping score inference and browser MusicXML construction; cold loads locally served model files, warm uses initialized and warmed sessions |
| Library recording import | 70.6 s first use; 55.3 s cached-cold; 48.7 s warm | Same WAV through the Library and SQLite save; first use downloaded the models from Hugging Face, cached-cold reinitialized from device storage, warm reused the sessions |

The Aria comparison uses the app's actual allowed-token masks, weights, temperature and min-p cutoff. KL is in nats; probabilities removed by the cutoff are smoothed at `1e-12` so the comparison remains finite. Mean top-k overlap with the full-precision distribution was 0.9645 for ONNX and 0.9646 for MLX. The sampled contexts are generated exercises, not recorded performances; broader fixture coverage is still needed. The gate requires ONNX's mean and 95th-percentile KL to be no worse than MLX, and records regression caps at 1.1 times the MLX values.

Real Safari 27.0.1, driven by `safaridriver` on the same Mac, ran the published Aria graph with KV outputs in WebGPU buffers. In two local-server runs with verbose logging off, model loading took 2.6–4.0 seconds, a 14-token prefill took 102–223 ms, and the median of 32 subsequent single-token steps was 39–41 ms (about 24–26 tokens/s). A verbose run assigned all 81 four-bit matrix multiplications and 878 other nodes to WebGPU, with 287 on the CPU provider; the [current graph's node list](/docs/measurements/safari-aria-equal-node-placements.txt) records each assignment. These model-stage timings are not iPhone or complete Reading/Duet latency measurements.

The preceding Aria graph placed 303 nodes on the CPU provider and 975 on WebGPU, identically in Safari and Chrome. The CPU nodes were 83 Gather, 64 Mul, 49 Add, 48 Div, 17 Cast, 16 Slice, 16 IsNaN, four Unsqueeze, two Concat, two Range, one Shape and one LessOrEqual. The IsNaN nodes consumed GPU softmax outputs, and ORT inserted 16 GPU-to-CPU and 16 corresponding CPU-to-GPU copies; the [previous graph's node list](/docs/measurements/safari-aria-isnan-node-placements.txt) records each assignment. The current graph replaces IsNaN with an equivalent self-equality test and logical negation, which ORT assigns to WebGPU; a synthetic Safari test distinguished NaN from finite and infinite values. In single comparison runs, its warmed median was 41 ms/token in Safari and 15 ms/token in Chrome, versus 61 and 32 ms for the preceding graph. Across 60 masked choices, the current graph on Safari WebGPU had mean KL 0.084 and p95 0.525 against full precision, both below MLX's 0.511 and 0.851. Broader device validation is still needed.

On the same Safari, a two-second live transcription window took 152–167 ms after the first run with the split graph: WebGPU convolution followed by an eight-thread SIMD WASM recurrent session, including the transfer. The split's convolution session placed 146 nodes on WebGPU and 35 on the CPU provider; the recurrent session placed all 70 nodes on the CPU provider. The maximum onset-tensor difference from the Python fixture was `0.00000123`, and all three reference notes matched. For comparison, the unsplit graph took 930–1053 ms with WebGPU selected, and 318–351 ms on eight-thread WASM; both found the same notes. The split exceeds the 128 ms audio hop in this run, and Safari's end-to-end note-to-green latency has not yet been compared with Python.

The TypeScript composer timings include constrained sampling and chord probes, but exclude downloading and opening the model. They use the preceding Aria graph and cover two scores from an empty practice history, not a full Reading session. A separate record/replay test checks 48 generated compositions across all 24 stages against the Python composer.

The transcription fixture contains three sampled piano notes. The split graph's maximum onset-tensor difference from the Python reference was about `0.0000023`, and it detected the same three pitches. The full graph took roughly 1.03 seconds per window on WebGPU; pruning and splitting matters. A four-thread Python reference took roughly 125–158 ms per window in these measurements. An exploratory fp16 conversion clamped constants and changed onset values by as much as 0.409, so it is not the current candidate.

The Reading comparison uses the existing app's `ReadingStream` and score renderer. A local test proxy provides the cross-origin isolation needed for threaded WASM, and swaps only the transcription call. The sampled note is rendered into a synthetic microphone; no physical microphone was used. That particular comparison does not validate the complete standalone browser app. The iOS shell, account sync, download sizes and memory usage are not yet validated.

The transcription-only measurements exclude model download and initialization, audio-file decoding, and score writing. The worker pool preserves the reference decoder's dependence on the preceding segment, and the app selects four or three workers only when the browser reports enough memory and cores; other devices use one. These are single-run Mac measurements, not iPhone results. Quantization and parity on a broader range of recordings remain to be tested.

Drill takes use Transkun after resampling the captured 16 kHz audio with the same polyphase filter as the Python app. On a 16-second recording converted through the microphone rate, browser and Python each found 83 notes, all matched within 30 ms; the maximum onset difference was 0.010 ms and the maximum duration difference was 0.046 ms. The simulated five-finger take ended after nine detected attacks and produced a clean nine-note assessment. The browser CI job exercises that microphone-to-results flow with a pinned model and piano sample; these examples do not replace a broad performance evaluation.

The score-model prototype matched every greedy token in all 14 output streams against the upstream public Python checkpoint for identical input tokens. The reference carries 64 generated tokens between the two chunks, so they were decoded in order. When the browser's own transcription supplied the input, small timing differences changed 3 onset, 4 duration, 3 pitch and 2 velocity buckets; the score decoder produced 906 valid tokens against the reference's 905. Using the Python detokenizer for both streams, MUSTER's aligned combined error was 0.241%, within the 0.167–4.153% range of four Python runs with each note onset perturbed by ±0.02 ms. Aligned pitch F1 was 0.9983, versus 0.9651–0.9989 for the jitter runs. The key, meter and 56-bar count matched; the notes did not differ solely by a global shift. MUSTER's identical-looking jitter output still measured nonzero error, so these numbers include its alignment and notation-processing behavior. This is a single recording; that prototype used the Python detokenizer and excluded audio decoding and score construction. The upstream checkpoint and its converted files remain local while redistribution permission is pending.

The app's default is Eric Fithian's retrained 120M model, not the upstream public checkpoint. Its converted eight-layer decoder matched all 14 greedy output streams on the same 960 input notes. Starting with browser transcription changed 3 onset, 4 duration, 3 pitch and 2 velocity input buckets, but all 898 output tokens still matched. The browser MusicXML writer matched all 898 Python reference notes at absolute beats, key, meter and 57 bars; there was no bar or pickup shift. MUSTER's aligned combined error was 0.130% and aligned pitch F1 was 0.9967, exactly the same as all four ±0.02 ms Python onset-jitter runs; aligned voice F1 was 100%. MUSTER measured nonzero error even for these identical scores. This is a single recording, with no Safari or iPhone measurement.

The overlap prototype waits for 512 notes that cannot change during later segment stitching, then starts the first score chunk while transcription continues. It verifies that this prefix remains identical when transcription completes, and both the three-worker and four-worker runs produced the same tokens as the sequential run. In these single runs, initializing both models and reading the already-decoded audio took another 3.9 seconds with three workers and 4.9 seconds with four; neither timing includes a model download, audio-file decoding or MusicXML construction. Initializing the score sessions concurrently with four busy transcription workers instead took 56.6 seconds from transcription start to score tokens, so the runs above initialize them before starting transcription. These are prototypes rather than full cold- and warm-import timings.

The WAV-to-MusicXML prototype adds worker audio decoding and browser score writing. The cold run includes session initialization and reads locally served graphs; it does not include downloading and verifying models from Hugging Face. The warm run initializes and exercises both inference sessions before starting the clock. Both produce the same MusicXML and score tokens. Neither is a measurement of the finished Library interface, a first network download, another browser, or a physical microphone recording.

The Library timings cover the file selection through the saved song, including audio decoding, model setup, transcription, score writing and saving. The first-use run fetched all six required model files from Hugging Face and took 70.6 seconds on this connection. A separate locally served run took 67.1 seconds on its first cache fill, 55.3 seconds after reloading from the cache, and 48.7 seconds with sessions already open. Each was a single run; network speed and other devices will vary. The first-use result exceeds the 60-second target but remains under the two-minute worst-case budget. A separate synthetic microphone recording passed the capture-to-saved-song flow; it was not a physical-microphone test.

Model files are verified against their pinned SHA-256 and size when downloaded. A marker tied to the exact URL, revision, hash and size allows later loads to check the stored size without hashing the entire file again. If the marker is missing, the file is hashed again; a size mismatch fails the integrity check. As requested, a same-size change to a marked cached file is not detected until the file is reverified or inference fails.

For a three-second synthetic stereo fixture, Chrome and Playwright WebKit decoded MP3, M4A/AAC, FLAC and WebM/Opus at the file's native sample rate and then used the same polyphase resampling as Python. All eight results had the same sample count as ffmpeg and RMS error below 0.000027 on normalized audio (the regression tolerance is 0.005). Chrome used WebCodecs for AAC, FLAC and WebM/Opus and Web Audio for MP3; Playwright WebKit used WebCodecs for AAC and WebM/Opus and Web Audio for MP3 and FLAC. The WebM path accounts for Opus pre-skip and discard padding explicitly. A synthetic Chrome MediaRecorder recording also matched ffmpeg's sample count and had RMS error below 0.000001. These are not real Safari format-decoding results.

Transkun's current WebGPU feature graph is not used for recordings: on the first padded 16-second window it chose different interval paths on 10 of 90 tracks, while browser WASM and Python ONNX CPU matched PyTorch. The spectrogram was close to the CPU reference, but the first convolution already differed substantially. ORT graph optimization set to `disabled` or `basic` did not remove the discrepancy. Further GPU investigation is needed before enabling that path.

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
uv run --frozen python -m piano_duet.recording_onnx
node tests/inference/download-models.mjs aria
PIANO_ARIA_MODEL_DIR=.cache/ci-models/aria node tests/inference/measure-browser.mjs chrome aria webgpu
node tests/inference/measure-browser.mjs chrome transcription split-fp32
PIANO_ARIA_MODEL_DIR=.cache/ci-models/aria node tests/inference/measure-safari.mjs aria webgpu
node tests/inference/measure-safari.mjs transcription split-fp32
PIANO_ARIA_MODEL_DIR=.cache/ci-models/aria node tests/inference/verify-aria-safari.mjs
node tests/inference/verify-recording-transcription.mjs path/to/mono-44100hz.wav 180 pool 4 3 --score
```

Add `--verbose` to a Safari measurement to include ORT node-placement diagnostics; time the non-verbose run separately because logging changes inference speed.

With `npm run dev --prefix site` running in another terminal, `node tests/inference/verify-reading-composer.mjs first_notes` and `node tests/inference/verify-reading-composer.mjs pairs` exercise the browser composer with the local Aria model.

For the upstream reference score-model check, the Python reference setup creates the isolated `.cache/m2st` environment and downloads the upstream public checkpoint for local use. With that setup complete and a local MIDI performance, run:

```sh
.cache/m2st/venv/bin/python -I src/piano_duet/score_onnx.py
.cache/m2st/venv/bin/python -I tests/inference/score_onnx_parity.py
.cache/m2st/venv/bin/python -I tests/inference/score_fixture.py path/to/performance.mid
node tests/inference/verify-score-browser.mjs webgpu
```

The app's converted checkpoint is [published under CC BY-NC-SA 4.0](https://huggingface.co/ericfithian/piano-duet-score-onnx) and pinned in the model catalog. The original PyTorch checkpoint remains local.
To reproduce the combined prototype with the same 44.1 kHz mono recording on both sides, generate the recording and score fixtures, then run:

```sh
node tests/inference/verify-recording-transcription.mjs path/to/mono-44100hz.wav 180 pool 4 3 --midi-fixture
.cache/m2st/venv/bin/python -I tests/inference/score_fixture.py .cache/m2st/recording-fixture.mid
node tests/inference/verify-recording-score.mjs
```

For the written-score comparison, install [MUSTER](https://github.com/TimFelixBeyer/amtevaluation.github.io) at revision `4ef1165edda1f719068c4c699bd8ab2076e4d7ec` into a separate `.cache/muster/venv`, then run `uv run --frozen python tests/inference/score_sensitivity.py`. The jittered performances are written as MIDI with the app's millisecond rounding, as in the reference import path. The comparison uses the same public score checkpoint and Python MusicXML detokenizer for both token streams; it reports MUSTER's components and a pitch F1 calculated from its aligned pitch, missing and extra rates.

To test the local default checkpoint instead, pass `--checkpoint .cache/m2st/pianoscore-medium-pianocore45-syn40nonclassical-soup2.ckpt` and a distinct `--output` to the exporter and fixture generator. Set `PIANO_SCORE_MODEL_DIR` and `PIANO_SCORE_FIXTURE` for the browser checks; `PIANO_RECORDING_PCM` and `PIANO_SCORE_TOKEN_OUTPUT` select the combined check's input and output. Pass the same checkpoint, fixture and token paths with `--checkpoint`, `--fixture` and `--browser-tokens` to `score_sensitivity.py`, together with `--notes` and a distinct `--output`. Pass `--browser-xml` to check browser-written MusicXML rather than detokenizing browser tokens in Python.

CI downloads the four published models and the original Kong reference graph at pinned commits, verifies their sizes and SHA-256 hashes, and caches them between runs. It checks Aria's 60 masked choices against saved FP32 and MLX reference distributions, compares both live-transcription graphs with the original graph on the same synthetic window, compares full-phrase notes and durations with Python across two windows using both the GPU/WASM split and WASM fallback, checks Transkun's interval paths and attribute heads against the original checkpoint packaged with Transkun, and tests 520 synthetic notes through both score-model chunks. The broader recorded-performance and device measurements above are local checks. The paired Reading test also needs the reference app running on port 8879 with a separate learner database under `.cache/browser-inference/`; `tests/inference/reading-latency.mjs` never uses the existing learner database.
