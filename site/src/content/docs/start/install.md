---
title: Install
description: Install Piano Duet on an Apple Silicon Mac with one command.
---

Piano Duet is a Mac app that runs in your browser. Every model runs on your Mac, so it needs:

- An Apple Silicon Mac (M1 or later) with macOS 14 or later
- About 8 GB of free disk space, for the models and their Python environments
- A microphone near a piano. The built-in microphone works.
- Google Chrome is recommended. Safari should work but has not been verified.

## One-line install

Open **Terminal** and run:

```sh
curl -fsSL https://piano-duet.vercel.app/install.sh | sh
```

The installer:

1. Checks that this is an Apple Silicon Mac with macOS 14 or later, and that Git is available. If Git is missing, it asks you to run `xcode-select --install` first.
2. Installs [uv](https://docs.astral.sh/uv/), the Python package manager, if you don't have it.
3. Downloads Piano Duet to `~/.piano-duet` and installs its pinned dependencies.
4. Downloads the models once, about 3 GB, and converts Aria to a 4-bit MLX checkpoint.
5. Adds a `piano-duet` command to `~/.local/bin`.

[Read the script](https://github.com/Eric-Fithian/piano-duet/blob/main/site/public/install.sh) before running it, if you like. Set `PIANO_DUET_HOME` to install somewhere else.

## Start it

```sh
piano-duet
```

The app opens at **http://127.0.0.1:8765**. Leave the Terminal window open while you play; **Ctrl+C** stops it. See [your first session](/docs/start/first-session/) for what to do next.

## Update

```sh
piano-duet update
```

This pulls the latest version, syncs dependencies and fetches any new models. Your learner history in `~/.piano-duet/.local/` is kept.

## Install from a clone

If you'd rather manage the checkout yourself:

```sh
git clone https://github.com/Eric-Fithian/piano-duet.git
cd piano-duet
uv sync --frozen
uv run --frozen piano-duet setup
uv run --frozen piano-duet
```

Models, samples and the notation library live in `.cache/`, not in Git. Setup pins the original model revisions, downloads about 2.8 GB of Aria and transcription weights, creates a 371 MB MLX checkpoint, and installs the score-writing model in its own environment under `.cache/m2st`. VexFlow 5.0.0 is downloaded with SHA-512 verification, and its bundle and fonts are served locally. Setup is repeatable, and failures are reported directly. No model training or cloud account is needed.

`Piano Duet.command` in the checkout is a double-clickable launcher for macOS Terminal.

## Uninstall

```sh
rm -rf ~/.piano-duet ~/.local/bin/piano-duet
```

This also deletes your learner history. Copy `~/.piano-duet/.local/learner.sqlite3` first if you want to keep it, or use **Progress → Export history** in the app.
