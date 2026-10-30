---
title: Privacy
description: How the current Python reference keeps audio and practice history local.
---

The current Python reference has no account and no server of its own on the internet. The only network access is during setup and updates, to download dependencies, model weights and piano samples, plus YouTube when you choose **From YouTube**.

The browser rebuild is not complete. Its local event log and model cache stay on the device; account sync is not yet implemented. Its intended sync will carry practice events and settings, never audio or model files.

Audio is processed in memory and sent only to a server bound to `127.0.0.1`. No audio recordings are saved, and no inference calls leave your computer. Recognized notes and contextualized assessments persist in the local learner database. Sample playback, scripts, and styles are also local. MIDI files are saved only when you request an export.

## What is saved

Every completed transcription produces an attempt: the full recognized performance, exact prompt and target, mode, help used, familiarity, audio signal metadata, recognition support, observations, and derived skill evidence. The original inputs and versioned assessment are stored separately in **`.local/learner.sqlite3`**, outside the model cache and ignored by Git. The app saves recognized notes, not audio recordings. Incomplete or empty recognition does not establish ability. AI replies are never treated as user performances.

Your history stays in `.local/learner.sqlite3` inside the install folder (`~/.piano-duet` by default). **Progress → Export history** downloads it as JSON, and deleting the folder deletes it.

## The local server

The server listens only on `127.0.0.1`, so other machines on your network can't reach it, and it refuses state-changing requests that don't come from its own page.
