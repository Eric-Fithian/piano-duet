---
title: Privacy
description: How the current Python reference keeps audio and practice history local.
---

The current Python reference has no account and no server of its own on the internet. The only network access is during setup and updates, to download dependencies, model weights and piano samples, plus YouTube when you choose **From YouTube**.

In the browser app, microphone audio and imported recordings are processed in memory on your device and are not uploaded or saved. Recognized notes, songs and practice events are kept in the browser's local SQLite database; the model cache is also local. Models and piano samples are downloaded when needed. Account sync is not yet implemented; its intended scope is practice events and settings, never audio or model files.

In the Mac reference app, audio is processed in memory and sent only to a server bound to `127.0.0.1`. No audio recordings are saved, and no inference calls leave your computer. Recognized notes and contextualized assessments persist in its local learner database. Sample playback, scripts, and styles are also local. MIDI files are saved only when you request an export.

## What is saved

In the Mac reference app, every completed transcription produces an attempt: the full recognized performance, exact prompt and target, mode, help used, familiarity, audio signal metadata, recognition support, observations, and derived skill evidence. The original inputs and versioned assessment are stored separately in **`.local/learner.sqlite3`**, outside the model cache and ignored by Git. The app saves recognized notes, not audio recordings. Incomplete or empty recognition does not establish ability. AI replies are never treated as user performances.

Your history stays in `.local/learner.sqlite3` inside the install folder (`~/.piano-duet` by default). **Progress → Export history** downloads it as JSON, and deleting the folder deletes it.

## The local server

The server listens only on `127.0.0.1`, so other machines on your network can't reach it, and it refuses state-changing requests that don't come from its own page.
