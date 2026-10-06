# Piano Duet

A local piano partner for Apple Silicon Macs, inspired by Google's AI Duet. Play an acoustic piano into your microphone; after a pause, a piano transformer plays a continuation through your speakers. Both hands and chords are supported. There is no on-screen keyboard to play.

The generator is **Aria**, a 2025, approximately 650-million-parameter piano transformer trained on roughly 60,000 hours of expressive piano MIDI. This app uses the generation-tuned checkpoint and 4-bit MLX inference on the Mac GPU. Microphone audio becomes pitches, onset times, durations, and velocities through the piano-specific ByteDance/Kong transcription model running locally in ONNX Runtime.

## Run

Already installed on this Mac. Run from this directory:

```sh
uv run --frozen piano-duet
```

`Piano Duet.command` is also provided as a launcher for standard macOS Terminal configurations.

The app opens at **http://127.0.0.1:8765**. Click **Enable microphone** and allow the browser's microphone request. Keep quiet for the one-second room calibration, play, then pause. **Space** or **Answer now** asks for a reply immediately. **Stop** releases the microphone and stops playback. Leave the Terminal window running; Ctrl+C stops the server.

Use **Try a phrase** to exercise the actual audio → transcription → Aria → piano playback path without a microphone. **Save MIDI** exports the recognized notes and AI replies in the current conversation. **New conversation** clears musical context. Reloading the page also starts fresh.

**Sheet music** displays the full conversation as separate **You** and **Duet** phrases on treble and bass staves, including chords, rests, ties, and accidentals. Scroll within the score to revisit earlier phrases. The reply is highlighted during playback. **Piano roll** shows the latest exchange with its original timing.

Written rhythms are approximate: notes snap to a sixteenth-note grid, with nearby attacks grouped into chords. Tempo is estimated per exchange; **Set BPM** overrides it. Meter defaults to 4/4, with 3/4 and 6/8 available. The key signature follows the detected key. **Spelling** chooses sharps or flats for chromatic notes; notes in the scale use the key's spelling. These notation controls never change audio or exported MIDI. The app splits notes around middle C for the two staves; it does not infer fingering, triplets, or the original score from a recording.

## Duet and learning modes

**Duet mode** continues the conversation as before. **Learning mode** follows a single practice cycle:

1. Play an idea, then pause or press **Answer now**.
2. Hear your practice target: the same phrase with model-suggested pitch corrections.
3. Play the target back. **Hear target again** replays it before your attempt.
4. Receive a score out of 100. Your next phrase starts a new learning round.

Learning computes **surprise = 1 − P(played pitch | original preceding notes)** from Aria's actual logits. At each note, it sums the probabilities of that pitch's velocity tokens and normalizes over the 88 piano pitches. It uses temperature 1 without sampling, top-k filtering, key masks, or difficulty constraints. When surprise exceeds **Correct above surprise** (98% by default), it substitutes the most probable pitch. A proposed substitution that would duplicate another pitch in the same chord is kept unchanged and marked **chord overlap**. The note-by-note table shows every probability, surprise, expected pitch, and correction.

The model consumes your original notes one at a time with a cached causal prefix; corrections are never fed back as evidence for later predictions. It uses Aria's pitch/velocity → onset → duration token order, so pitch surprise is conditional on earlier note tokens rather than on the current note's exact onset. After the context fills, scoring retains recent original notes in a rolling context of at most 512 notes; every note in a long performance is still scored. The first notes have little musical context. High surprise means unexpected to this model, not objectively incorrect music.

Corrections preserve recognized onset times, durations, velocities, and phrase length, removing only leading silence for playback. The target is stored in memory until the attempt is scored or a new idea replaces it. Your idea, target, and playback appear as separate sheet-music phrases. Changing modes starts a fresh conversation.

Playback scoring aligns attacks and chords in order, allowing missing and extra attacks. Pitch accuracy is the harmonic mean of note precision and recall. The overall score is pitch accuracy multiplied by an 80% pitch / 20% relative-rhythm factor. Rhythm uses matched attack intervals after compensating for one consistent tempo change; timing deviations within 60 ms are tolerated, with larger errors reducing the rhythm score smoothly. Initial recording delay and chord ordering do not count against you. The breakdown includes matched, wrong, missing, and extra notes. Durations and velocities are not graded. Scores depend on microphone transcription accuracy; a recording with no recognized notes asks for another attempt instead of scoring silence.

## Following your key

The app estimates a major or natural-minor key from your recognized notes and restricts Aria's pitch tokens to that scale **before sampling**. Your own notes remain unchanged, including chromatic notes. The current estimate and the seven allowed notes appear under **Key of your latest phrase**. Sparse or ambiguous evidence is marked **tentative**, but replies still follow the estimated scale.

Key detection uses duration- and velocity-weighted pitch classes, tonal profiles, and scale fit from **only the latest phrase you played**. It recalculates immediately for each reply. Earlier phrases and AI replies never count as key evidence. Musical conversation history can still influence the continuation, within the latest phrase's scale.

Major and relative minor can be ambiguous, and transcription mistakes can affect the estimate. Minor replies use natural minor: raised sixths and sevenths are excluded by the strict scale constraint. The detector currently does not identify other modes or atonal playing. Key tracking adds no model and runs locally.

Chrome is recommended. Safari should support the required Web Audio and microphone APIs but has not been verified here. If permission was denied, check the browser's site permissions and macOS **System Settings → Privacy & Security → Microphone**. Choose the input device before enabling the microphone.

## First installation on another Mac

Requires an Apple Silicon Mac, macOS 14 or later, [uv](https://docs.astral.sh/uv/getting-started/installation/), and roughly 5 GB free disk space. Setup needs internet access to download dependencies, model weights, and piano samples. All subsequent inference and playback are local.

```sh
uv sync --frozen
uv run --frozen piano-duet setup
uv run --frozen piano-duet
```

Models, samples, and the notation library live in `.cache/`, not in Git. Setup pins the original model revisions, downloads about 2.8 GB of weights, and creates a 371 MB MLX checkpoint. VexFlow 5.0.0 is downloaded with SHA-512 verification; its bundle and fonts are served locally. Python dependencies are pinned in `uv.lock`. Setup is repeatable; failures are reported directly. No model training or cloud account is required.

## Playing together

- Put the Mac or an external microphone near the piano. A quiet room helps. Built-in voice noise suppression, echo cancellation, and automatic gain control are disabled to preserve musical attacks.
- Your turn has no fixed time limit. **Reply after a pause** is on by default; **Leave a pause** controls the silence wait. Turn automatic replies off to play through rests, then use **Answer now** or **Space** when finished. Long performances take longer to transcribe and use more memory; transcription progress appears in the status. The full performance is transcribed and displayed, while Aria conditions on the most recent 180 notes.
- The microphone is excluded from inference during the AI's turn, followed by a 0.75-second speaker-decay guard. You can use speakers; headphones reduce room echo further. Simultaneous accompaniment is not implemented.
- **Reply length** sets a 2–12 second target. Aria receives its trained ending cue and can continue a few seconds to reach a resolution or a clear pause. Complete chords and final note durations are preserved. A short ending buffer chooses a musical boundary if the model keeps going. Sustained piano resonance may keep an input phrase open: use Space, release the sustain pedal, or raise **Noise gate**.
- **Reply difficulty** runs from **1 · Gentle** to **5 · Expert**, defaulting to **3 · Moderate**. Lower levels restrict attack speed, notes per chord and per hand, register, hand span, and jumps between hand positions. Gentle allows one note per hand per attack; Expert allows up to eight notes per attack. Higher levels allow complexity without requiring it. These are approximate playability controls, not formal piano grades: hand assignment is based on middle C, and fingering is not inferred. Difficulty constrains pitch, onset, and duration tokens before sampling; it does not delete notes afterward or change your playing. Changes apply to the next reply.
- Generated notes have a tempo-dependent minimum duration of 60–100 ms. Repeated short-note loops trigger the ending cue and longer articulation, and the same pitch cannot retrigger within 60 ms. These sampling constraints do not edit the notes you played.
- **Note confidence** defaults to 0.75 to reduce false attacks and harmonics. Lower it for missed soft notes, or raise it for extra notes. The display shows what the model actually heard.
- **Adventurousness** changes sampling temperature. Aria conditions on the recent conversation (up to 180 notes); it is primarily a piano continuation model, so replies may echo or repeat your phrase. Music quality depends on the input and is not guaranteed.

Microphone transcription is approximate. Room acoustics, pedal resonance, fast repeated notes, and distant microphones can cause missing or extra notes. Note durations incorporate estimated sustain. The 2025 upgrade is the generation model; the fast piano transcription model is from 2020. This is turn-taking interaction, not zero-latency live accompaniment.

Audio is processed in memory and sent only to a server bound to `127.0.0.1`. No recordings are saved, and no inference calls leave your computer. Sample playback, scripts, and styles are also local. MIDI is saved only when you request an export.

## Verification

```sh
uv run --frozen pytest -q
node --test tests/*.test.mjs
uv run --frozen ruff check src tests
uv run --frozen piano-duet benchmark
```

The benchmark renders a two-handed piano phrase, checks note recognition at three input levels, and measures transcription and time to the first generated note on the actual local models. Synthetic benchmark audio and metrics go to `.cache/benchmark/`. It is a repeatable smoke test, not an estimate of accuracy on your acoustic piano.

## Sources and credits

- [Aria paper and official implementation](https://github.com/EleutherAI/aria), Apache 2.0. [Generation checkpoint](https://huggingface.co/loubb/aria-medium-base/tree/5a1ef36c5007ee10fbe57d61d96725a7244bd2b2), `model-gen.safetensors`. The upstream README's separate `aria-medium-gen` URL is unavailable; the author's base repository contains the generation-tuned weights.
- [High-resolution Piano Transcription](https://github.com/bytedance/piano_transcription) and [original decoder](https://github.com/qiuqiangkong/piano_transcription_inference), MIT. [ONNX conversion by stelee](https://huggingface.co/stelee/piano-transcription-onnx).
- Piano samples: [tonejs-instruments by Nicholaus P. Brosowsky](https://github.com/nbrosowsky/tonejs-instruments), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Samples are pitch-shifted and shaped with note envelopes for playback.
- Sheet music: [VexFlow 5.0.0](https://github.com/vexflow/vexflow), MIT. Its package license is preserved in `.cache/notation/LICENSE`.
- Key-profile reference: [Krumhansl–Kessler profiles in music21's documentation](https://music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html). The app combines these with scale coverage for the current phrase; music21 is not a runtime dependency.
- Interaction inspiration: [A.I. Duet](https://github.com/googlecreativelab/aiexperiments-ai-duet), by Yotam Mann with Google's Magenta and Creative Lab teams. This app is independent and does not reuse the old application code.
