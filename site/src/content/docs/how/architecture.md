---
title: Architecture
description: The local-first browser foundation and the Python reference implementation.
---

The browser rebuild is in progress. Its app lives at `/`, and these docs live under `/docs`. A dedicated worker keeps an append-only event log in SQLite using OPFS; model files are cached on the device by version and digest. Aria and live transcription have browser inference prototypes with WebGPU and WASM execution. Practice modes, sync, the other models and the iOS shell are not yet complete.

The existing Python app remains the reference implementation. It serves a browser page from a server bound to `127.0.0.1` and runs its models on the Mac:

```text
 Browser (vanilla ES modules)                       Python server (FastAPI, uvicorn)
 ───────────────────────────                        ────────────────────────────────
 microphone ─▶ AudioWorklet capture ─┐              transcription.py        live piano model (ONNX Runtime)
                                     ├─ loopback ─▶ recording_transcription Transkun 2.0 for drills and recordings
 attack counter (spectral flux) ◀────┘    HTTP      generation.py           Aria, 4-bit MLX, constrained decoding
 score_view / engraving (VexFlow) ◀──────────────── practice, reading_*,    curriculum, assessment, learner profile
 sampled piano playback                             drills, library         (SQLite in .local/learner.sqlite3)
```

## The front end

`src/piano_duet/static/` is plain HTML, CSS and ES modules, with no build step. `app.mjs` wires the modes together; each mode has its own module (`reading.mjs`, `drills.mjs`, `library.mjs`, `practice.mjs`, `learning.mjs`, `song_editor.mjs`).

- **Audio:** `audio.mjs` captures microphone audio with an AudioWorklet, counts attacks in the browser for drills, and plays the sampled piano.
- **Notation:** `notation.mjs` quantizes notes into a score model. `engraving.mjs` lays out systems with VexFlow, and `score_view.mjs` is the one score viewer every mode uses, with zoom, layout, following and overlays.

## The server

`server.py` serves the page and a JSON API, and refuses non-GET requests that don't come from its own origin. The main pieces:

| Module | Role |
| --- | --- |
| `transcription.py` | Live note recognition with the ByteDance/Kong piano model in ONNX Runtime |
| `recording_transcription.py` | Transkun 2.0 for drill takes and imported recordings |
| `generation.py` | Aria inference on MLX, including the constrained decoder |
| `reading_curriculum.py`, `reading_music.py`, `reading_stages.py` | The 24-stage reading curriculum and its score composer |
| `practice.py`, `assessment.py`, `profile.py` | Task selection, scoring and the learner profile |
| `drills.py` | Drill plans, take analysis and levels |
| `library.py`, `score_import.py`, `score_model.py`, `youtube.py` | Songs, MIDI and MusicXML import, and recording-to-score |
| `key_tracking.py`, `difficulty.py`, `phrasing.py` | Key estimates and playability constraints for Duet |

## Models

| Model | Runs on | Used for |
| --- | --- | --- |
| [Aria](https://github.com/EleutherAI/aria), about 650M parameters | Mac GPU via MLX, 4-bit | Duet replies, Variations surprise, Reading scores |
| [High-resolution Piano Transcription](https://github.com/bytedance/piano_transcription) | ONNX Runtime | Live recognition in Reading, Library, Practice and Duet |
| [Transkun 2.0](https://github.com/Yujia-Yan/Transkun) | Mac GPU | Drill takes and recordings |
| [MIDI2ScoreTransformer](https://github.com/TimFelixBeyer/MIDI2ScoreTransformer) | CPU, separate environment | Writing a score from a recording |

`piano-duet setup` downloads all of them at pinned revisions into `.cache/`.
