# Contributing to Piano Duet

Thanks for helping. Bug reports, practice-material ideas, documentation fixes and code are all welcome.

## Before you start

- **Bugs:** open an [issue](https://github.com/Eric-Fithian/piano-duet/issues/new/choose) with your Mac model, macOS and browser versions, the mode you were in, and what you heard versus what the app showed. **Progress → Export history** can help when a note was misheard.
- **Larger changes:** open an issue or a draft pull request first, so we can agree on the approach before you invest in it.
- **Security issues:** report them privately, as described in [SECURITY.md](SECURITY.md).

## Set up

For the browser foundation, you need Node.js 24 or later. The Python reference and full model comparisons also need an Apple Silicon Mac and [uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/Eric-Fithian/piano-duet.git && cd piano-duet
npm ci
npm ci --prefix site
npm run dev  # browser app at http://127.0.0.1:5173 and docs under /docs
```

The browser app is under construction; its practice modes and published model catalog are not ready. To run the working Python reference, use `make setup` and `make dev` instead. Python edits restart that server, and browser edits refresh it without reloading the models.

## Make a change

For account and sync tests, start Docker, install the Supabase CLI, run `supabase start`, then `npm run test:sync`. The tests use local accounts and Mailpit; they do not need a hosted project or provider credentials. To enable sign-in in a local browser, supply an untracked `site/app/sync-config.json` containing `{"url":"<local API URL>","anonKey":"<local anon key>"}` using the values from `supabase status`. A deployment must serve the same JSON at `/sync-config.json` at runtime. The URL and anon key are public client configuration; never use a service-role key. Optional `providers` may contain `"apple"` and `"google"` after those providers and their credentials are configured in Supabase. The hosted project and provider credentials still need to be set up separately. Restart the dev server after changing its configuration if necessary.

1. Branch from `main`.
2. Make the change, with tests. Python tests live in `tests/test_*.py`, browser-module tests in `tests/*.test.mjs`, TypeScript parity tests in `tests/core/`, and browser storage tests in `tests/web/`. These tests do not need the downloaded models.
3. Run `make check`, which is what CI runs. Run `make site-build` if you touched `site/`.
4. Update the documentation in `site/src/content/docs/` if behaviour changed.
5. Open a pull request. CI must pass before it can merge, and Vercel comments with a preview link for website changes.

Keep each pull request to one change, and write the description around *why* it is needed.

## Code style

- **Fail fast.** No silent fallbacks or swallowed exceptions. An unexpected state raises, and model errors are shown to the player rather than hidden.
- **Comments explain why**, not how. Every regular expression gets a comment saying what it matches.
- **Python:** each file has a `main()` right after its imports and constants. `ruff` is the linter and its configuration is in `pyproject.toml`. Commands run from the project root, and paths such as `.cache` are relative to it.
- **JavaScript:** plain ES modules with no build step. Match the surrounding code.
- **TypeScript core:** `src/core/` contains portable calculations being moved out of the Python reference. Run `npm run check:core` and `npm run test:core` to type-check and compare them with Python.
- **Local first.** Audio and inference stay on the device. Account sync is being designed for practice events and settings; audio and models must not be sent to it.

## Project layout

See [Architecture](https://piano-duet.vercel.app/how/architecture/) for how the browser, the server and the models fit together, and [CI and releases](https://piano-duet.vercel.app/contributing/ci/) for what runs on each pull request and how releases are cut.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md).
