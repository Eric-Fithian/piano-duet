---
title: Constrained decoding
description: How the reading curriculum steers Aria, the way structured output steers a language model.
---

The generator is **Aria**, a 2025, approximately 650-million-parameter piano transformer trained on roughly 60,000 hours of expressive piano MIDI. This app uses the generation-tuned checkpoint and 4-bit MLX inference on the Mac GPU. Microphone audio becomes pitches, onset times, durations, and velocities through the piano-specific ByteDance/Kong transcription model running locally in ONNX Runtime.

Aria is a decoder-only transformer over a piano token vocabulary. Each note is a pitch-and-velocity token, an onset token within a five-second segment, and a duration token. Reading mode doesn't ask Aria for a free continuation and then filter it. Instead it constrains every sampling step, the way structured output constrains a language model to valid JSON.

## What the curriculum fixes

Reading scores are written by the local **Aria** model under constraints, the way structured output constrains a language model to valid JSON. The curriculum fixes what the lesson needs and leaves the placement to Aria:
- **Context:** the clef, key, time signature and tempo.
- **Hand positions:** at least one position change per score, with the landing note after each change chosen from the notes you miss most.
- **The stage's interval** (a fourth or fifth in stages 3 and 4) at least once in every bar, wherever Aria puts it.
- **The stage's rhythmic figure** (dotted, offbeat, sixteenths, triplets) in two bars of each score, wherever Aria puts it in the bar; other bars use plain quarters and eighths.
- **Accidentals:** one or two per score from stage 17, on notes Aria chooses. In minor keys from stage 8, the raised leading note is always available.
- **Chords** start only on main beats. On each one, Aria's own probability of adding a chord note decides, weighted toward chords, and a bar without one gets one on its last main beat.
- **Cadences:** in stage 8, minor-key bars 2 and 4 close on the leading note and tonic.

## How Aria fills it in

Aria then writes the score note by note, choosing only among the tokens those rules allow: its pitch tokens are limited to the hand position and largest interval, onsets are fixed to the beat grid, and duration tokens to the bar's allowed rhythms. Each new score continues the one shown before it. Your weaker notes and intervals add weight to Aria's own probabilities, so practice stays targeted while the model supplies the musical continuation. Repeating one note three times or swinging between two notes for five is ruled out wherever the hand position allows another note. A score you have already seen is simply rewritten. Writing a score takes 0.1–0.7 s, the score is saved before it appears and never changes while visible, and model errors are surfaced rather than silently switching to random exercises. Introductions show single notes and need no model.

At each step the decoder masks every token the rules forbid, adds practice weights to the remaining logits, and samples with temperature 0.95 and a min-p cutoff. A token the rules leave no choice about is written without calling the model. Each new score is conditioned on the four bars before it, so consecutive scores continue each other musically.

## In Duet

Duet uses the same model with lighter constraints. The estimated key restricts pitch tokens, and **Reply difficulty** limits attack speed, notes per chord and hand, register, span and jumps, all before sampling. See [Duet and Variations](/docs/modes/duet/).
