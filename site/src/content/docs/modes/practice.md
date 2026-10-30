---
title: Practice
description: Guided practice across technique, sight-reading, theory, ear and repertoire, chosen from your learner profile.
---

One structured task supplies the instruction, reference notes, sheet music, playback, and assessment. Choose a focus or let the app choose your next step:

- **Technique:** major and natural-minor scales, with an even pulse and sound. Note names are provided so reading is not a prerequisite. Practice stages increase tempo and eventually use two octaves.
- **Fresh sight-reading:** newly generated scores target less accurate or less practiced notes and clefs. Score fingerprints are stored when issued, so the same score is never issued again, even after restarting. Hearing the example or opening help changes the attempt to assisted practice, without independent reading credit.
- **Applied theory:** construct named scales or chords, with optional reference help, playback, or score reveal. More advanced chord stages introduce inversions and seventh chords. Timing is not graded for theory tasks.
- **Playing by ear:** hear a melody, then find it on the piano with the score hidden. Revealing the score removes ear-assessment credit. Extra listens are recorded and reduce the weight of pitch evidence.
- **My repertoire:** rehearse a short starter piece, or name and keep your latest performance as a piece. Once familiar, the task starts with the score hidden. Unaided performances inform recall; performances with a score or example inform execution. Saved pieces currently assess stage 1 recall, without claiming an automatically inferred difficulty grade.

**Hear the beat** plays four beats at the suggested tempo without revealing notes. **Next exercise** considers weaknesses, unexplored material, demonstrated stage, and time since practice. It alternates skill areas, permits focused repair, explores new conditions, and revisits material after a break. This is an explicit local selection algorithm; no language model or remote teaching service makes these decisions.

An unsuccessful unaided theory task can lead to an execution check of the same notes with the answer shown. A difficult chord in repertoire can become an isolated chord exercise. These checks gather more evidence about the difficulty before treating it as a general weakness. Reading exercises target missed notes while preserving variety and never repeating an issued score.

## Your learner profile

Every completed transcription produces an attempt: the full recognized performance, exact prompt and target, mode, help used, familiarity, audio signal metadata, recognition support, observations, and derived skill evidence. The original inputs and versioned assessment are stored separately in **`.local/learner.sqlite3`**, outside the model cache and ignored by Git. The app saves recognized notes, not audio recordings. Incomplete or empty recognition does not establish ability. AI replies are never treated as user performances.

The shared profile has technique, reading, theory, ear, repertoire, and creating areas. A successful named-scale task can inform both theory and scale execution; an incorrect named-scale answer does not automatically diagnose a motor problem. Fresh reading updates expected-note, clef, interval, and key conditions. Spontaneous music contributes exploration history without invented note errors or a creativity score. Open **Progress** to see per-skill levels, evidence coverage, recent attempts, and exact expected versus heard notes. An attempt can be excluded or restored, recalculating all affected skills. **Export history** downloads the local records as JSON.

Levels 1–5 are app practice stages, not exam grades or a validated curriculum. Each skill summarizes up to 12 recent eligible attempts; establishing a stage requires at least three attempts at that stage or harder and at least 85% weighted accuracy. Repeating easy tasks cannot earn a harder stage. **Untested** and **Exploring** are distinct. An overall level describes tested material; the key/note breakdown shows its coverage, not mastery of every untested key. Recognition support is a heuristic from the transcription model's onset activations, not a calibrated probability. Insufficient support excludes an attempt from levels; strong support can still contain errors, so inspection and exclusion remain available. Loudness estimates use within-phrase velocity variation at reduced evidence weight and do not infer finger force or physical movement.

Pitch accuracy and relative rhythm remain separate from controlled speed: playing the right sequence steadily at half tempo preserves the rhythm score but demonstrates only half the requested speed. Rhythm and pitch errors affect targeted practice. Note duration, pedaling, fingering, posture, and movement are not assessed. All guidance and grading use audio alone.
