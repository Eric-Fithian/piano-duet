---
title: Privacy
description: How the current Python reference keeps audio and practice history local.
---

The current Python reference has no account and no server of its own on the internet. The only network access is during setup and updates, to download dependencies, model weights and piano samples, plus YouTube when you choose **From YouTube**.

In the browser app, microphone audio and imported recordings are processed in memory on your device and are not uploaded or saved. Recognized notes, songs and practice events are kept in the browser's local SQLite database; the model cache is also local. Models and piano samples are downloaded when needed. If account sync is configured and you sign in, the app sends your append-only practice events, songs, edits, exclusions and learner settings to your account. Devices rebuild progress from that shared history. Signing in merges the history already on this device with the account; signing out leaves the local history on this device. Audio and model files are never synced.

For **From YouTube link** in the browser app, you open and play the video in a separate tab and share that tab's audio with the app. The app records and transcribes the audio in memory on your device; it does not download or upload the audio. Capture happens in real time, so a four-minute video takes four minutes to capture. Tab audio sharing is supported in desktop Chrome and Edge. On other browsers and mobile devices, use **Audio file** or play the video aloud and use **Record audio**. The saved song includes the link, title and channel and follows your account sync settings.

In **Settings → Models**, you can inspect local downloads and browser storage, request persistent storage, manage model files, and run fixed-input tests. The diagnostics you copy contain browser, graphics adapter, storage and model-test details; they do not contain audio or practice history.

Learner settings follow your account: note confidence, reply behavior and difficulty, response length and adventurousness, score spelling, meter and tempo preferences, drill options, Reading tempo and selected mode. Microphone selection, the room-specific noise gate, and each app part's score-view zoom, layout, follow and look-ahead stay on the device.

In the Mac reference app, audio is processed in memory and sent only to a server bound to `127.0.0.1`. No audio recordings are saved, and no inference calls leave your computer. Recognized notes and contextualized assessments persist in its local learner database. Sample playback, scripts, and styles are also local. MIDI files are saved only when you request an export.

## What is saved

In the Mac reference app, every completed transcription produces an attempt: the full recognized performance, exact prompt and target, mode, help used, familiarity, audio signal metadata, recognition support, observations, and derived skill evidence. The original inputs and versioned assessment are stored separately in **`.local/learner.sqlite3`**, outside the model cache and ignored by Git. The app saves recognized notes, not audio recordings. Incomplete or empty recognition does not establish ability. AI replies are never treated as user performances.

Your history stays in `.local/learner.sqlite3` inside the install folder (`~/.piano-duet` by default). Deleting the folder deletes it.

To bring Mac app history into the browser, first quit the Mac app so its database is fully saved. In the browser, open **Settings → Import history from the Mac app** and select `.local/learner.sqlite3` from the install folder. The file is read on your device and merged into browser storage; importing the same file again adds no duplicates. Keep the Mac database until you have checked your progress and songs in the browser.

## The local server

The server listens only on `127.0.0.1`, so other machines on your network can't reach it, and it refuses state-changing requests that don't come from its own page.
