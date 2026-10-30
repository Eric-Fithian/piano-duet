---
title: Development
description: Run the app with hot reload, run the tests, and find your way around the code.
---

You'll need Node.js 24 or later for the browser foundation. The Python reference also needs an Apple Silicon Mac and [uv](https://docs.astral.sh/uv/). The [CONTRIBUTING guide](https://github.com/Eric-Fithian/piano-duet/blob/main/CONTRIBUTING.md) covers the workflow for pull requests.

```sh
git clone https://github.com/Eric-Fithian/piano-duet.git
cd piano-duet
npm ci
npm ci --prefix site
npm run dev    # app at http://127.0.0.1:5173, docs under /docs
```

The browser practice modes and model catalog are still being built. For the working Python reference, run `make setup` to install its dependencies, models and browser test engines, then `make dev` to start it at `http://127.0.0.1:8765`. Python edits restart that server; browser edits refresh its page without reloading the models.

## Checks

```sh
make check     # lint, Python, TypeScript and browser tests
make lint      # ruff
make test      # pytest, Node and Playwright tests
make benchmark # the real models on synthetic audio
```

The CI tests don't need the downloaded models. Full-model comparisons and their requirements are described in [Browser inference measurements](/docs/how/performance/).

The benchmark renders a two-handed piano phrase, checks note recognition at three input levels, and measures transcription and time to the first generated note on the actual local models. Synthetic benchmark audio and metrics go to `.cache/benchmark/`. It is a repeatable smoke test, not an estimate of accuracy on your acoustic piano.

## The website

The documentation site lives in `site/` and is built with [Astro Starlight](https://starlight.astro.build/).

```sh
make site      # http://localhost:4321/docs, with live reload
```

Pages are Markdown files in `site/src/content/docs/`. Every page has an **Edit page** link at the bottom.

## Layout

| Path | What's there |
| --- | --- |
| `src/piano_duet/` | The Python server, models and curriculum. See [Architecture](/docs/how/architecture/). |
| `src/piano_duet/static/` | The Python reference's browser interface |
| `src/core/` | Portable TypeScript calculations being compared with the reference |
| `tests/` | Python, Node and browser tests |
| `site/app/` | The browser app foundation, including its SQLite and model workers |
| `site/src/content/docs/` | This documentation |
| `.cache/` | Downloaded models, samples and notation fonts (ignored by Git) |
| `.local/` | Your learner database (ignored by Git) |

## Conventions

- Fail fast: no silent fallbacks. An unexpected state raises, and model errors are shown rather than hidden.
- Comment the *why*, not the *how*, and explain every regular expression.
- Every Python file has a `main()` right after its imports and constants.
- Run commands from the project root; paths such as `.cache` are relative to it.
