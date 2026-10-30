---
title: Development
description: Run the app with hot reload, run the tests, and find your way around the code.
---

You'll need an Apple Silicon Mac, [uv](https://docs.astral.sh/uv/) and Node.js 22 or later. The [CONTRIBUTING guide](https://github.com/Eric-Fithian/piano-duet/blob/main/CONTRIBUTING.md) covers the workflow for pull requests.

```sh
git clone https://github.com/Eric-Fithian/piano-duet.git
cd piano-duet
make setup     # uv sync, then download the models (once, about 3 GB)
make dev       # the app with hot reload at http://127.0.0.1:8765
```

`make dev` runs `uv run --frozen piano-duet --reload`. Python edits restart the server; HTML, CSS, and JavaScript edits refresh the browser automatically without reloading the models. The browser also refreshes after a server restart finishes warming up the models. Development pages and interface files bypass the browser cache. A refresh starts a new exercise and releases the microphone; press **Space** again to continue. Saved learner history persists.

## Checks

```sh
make check     # everything CI runs on the app: lint, Python tests, JavaScript tests
make lint      # ruff
make test      # pytest and node --test
make benchmark # the real models on synthetic audio
```

The tests don't need the downloaded models. The Python tests stand in for Aria with small fakes (`tests/fake_phrase.py`), and the JavaScript tests run the browser modules under Node.

The benchmark renders a two-handed piano phrase, checks note recognition at three input levels, and measures transcription and time to the first generated note on the actual local models. Synthetic benchmark audio and metrics go to `.cache/benchmark/`. It is a repeatable smoke test, not an estimate of accuracy on your acoustic piano.

## The website

The documentation site lives in `site/` and is built with [Astro Starlight](https://starlight.astro.build/).

```sh
make site      # http://localhost:4321, with live reload
```

Pages are Markdown files in `site/src/content/docs/`. Every page has an **Edit page** link at the bottom.

## Layout

| Path | What's there |
| --- | --- |
| `src/piano_duet/` | The Python server, models and curriculum. See [Architecture](/how/architecture/). |
| `src/piano_duet/static/` | The browser app: HTML, CSS and ES modules, with no build step |
| `tests/` | `test_*.py` for pytest, `*.test.mjs` for `node --test` |
| `site/` | This website |
| `.cache/` | Downloaded models, samples and notation fonts (ignored by Git) |
| `.local/` | Your learner database (ignored by Git) |

## Conventions

- Fail fast: no silent fallbacks. An unexpected state raises, and model errors are shown rather than hidden.
- Comment the *why*, not the *how*, and explain every regular expression.
- Every Python file has a `main()` right after its imports and constants.
- Run commands from the project root; paths such as `.cache` are relative to it.
