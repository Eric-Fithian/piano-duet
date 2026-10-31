---
title: Architecture
description: The local-first browser foundation and the Python reference implementation.
---

The browser rebuild is in progress. Its app lives at `/`, and these docs live under `/docs`. The browser reuses the interface in `src/piano_duet/static/`; its API requests go through an injectable local service. A dedicated worker keeps an append-only event log in SQLite using OPFS; model files and piano samples are cached on the device by version and digest. Reading uses the shared curriculum and local inference; Drills use Transkun for recorded takes; Library imports MIDI, MusicXML and recordings. Account sync exchanges the event log with Supabase and rebuilds progress on each device; Google sign-in is configured, with its first real account test pending. The iOS shell remains incomplete. [Inference measurements](/docs/how/performance/) include real Safari on a Mac; iPhone measurements are pending.

```text
 Shared interface ──▶ local service ──▶ TypeScript curriculum, scoring and library
       │                    │
       │                    ├──▶ inference workers ──▶ device models
       │                    └──▶ SQLite event-log worker ──▶ optional Supabase sync
       └──▶ microphone and piano playback
```

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

`src/piano_duet/static/` is shared HTML, CSS and ES modules. `app.mjs` wires the modes together; each mode has its own module (`reading.mjs`, `drills.mjs`, `library.mjs`, `practice.mjs`, `learning.mjs`, `song_editor.mjs`). The Python reference serves these files directly. The browser build bundles them with VexFlow and injects the local service before the interface starts.

- **Audio:** `audio.mjs` captures microphone audio with an AudioWorklet, counts attacks in the browser for drills, and plays the sampled piano.
- **Notation:** `notation.mjs` quantizes notes into a score model. `engraving.mjs` lays out systems with VexFlow, and `score_view.mjs` is the one score viewer every mode uses, with zoom, layout, following and overlays.

## The reference server

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

## Reference models

| Model | Runs on | Used for |
| --- | --- | --- |
| [Aria](https://github.com/EleutherAI/aria), about 650M parameters | Mac GPU via MLX, 4-bit | Reading scores |
| [High-resolution Piano Transcription](https://github.com/bytedance/piano_transcription) | ONNX Runtime | Live recognition in Reading and Library |
| [Transkun 2.0](https://github.com/Yujia-Yan/Transkun) | Mac GPU | Drill takes and recordings |
| [MIDI2ScoreTransformer](https://github.com/TimFelixBeyer/MIDI2ScoreTransformer) | CPU, separate environment | Writing a score from a recording |

The Python reference's `piano-duet setup` downloads its models at pinned revisions into `.cache/`. The browser downloads the licensed converted models from Hugging Face, verifies their hashes and caches them locally. The recording importer uses Eric Fithian's published score model; the upstream public MIDI2ScoreTransformer checkpoint remains separate and is not redistributed here.
