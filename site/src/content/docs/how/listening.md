---
title: How Piano Duet listens
description: Three listeners, each tuned to a different job — following you live, judging a take, and transcribing a recording.
---

All three run on your Mac.

## Following you live

Live recognition uses the same local piano model on overlapping two-second audio windows, with 150 ms of future context and confirmation across windows. Only a bounded audio window stays in memory. Each candidate needs both an onset above **Settings → Note confidence** and sustained frame evidence. For single-note exercises, simultaneous detections below 75% of the strongest onset's confidence × velocity are suppressed to reduce quieter harmonic guesses. Chord exercises keep quieter confirmed members and require all written pitches in the same attack. Grouping and repeat detection adapt to the score's smallest spacing. Wrong pitches are never snapped to the expected note or restricted to the score's key. Detection has a short delay and is approximate; room acoustics can still cause missed or extra notes.

## Counting attacks in a drill

Drills follow you in the browser itself. A spectral-flux attack counter looks for energy appearing at new frequencies every 10 ms, scaled to how loudly you've been playing over the last few seconds. Soft playing or a quiet microphone therefore counts as reliably as loud playing. The counter moves the score with you and decides when a take has ended. See [Drills → Takes](/modes/drills/#takes).

## Transcribing a take or a recording

Drill takes are transcribed by **Transkun 2.0** rather than the live model. On benchmark audio band-limited to the microphone's 16 kHz, it found 99% of the notes that sound together in chords with essentially no extras, while the live model at its 0.80 threshold found 83–85%. Lowering that threshold to 0.5 raised chord recall to 93% but added 8–9% stray notes. A 20-second take takes one to two seconds to transcribe. Reading and Library still use the live model, because they follow you note by note.

## Limits

Microphone transcription is approximate. Room acoustics, pedal resonance, fast repeated notes, and distant microphones can cause missing or extra notes. Note durations incorporate estimated sustain. The 2025 upgrade is the generation model; the fast piano transcription model is from 2020. This is turn-taking interaction, not zero-latency live accompaniment.
