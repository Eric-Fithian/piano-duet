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

The browser app is under construction: Reading, guided Practice, Drills, Library recording import, Duet and Variations use the local service and the pinned model catalog. The browser downloads model files when a mode first needs them. For the Python reference, run `make setup` to install its dependencies, models and browser test engines, then `make dev` to start it at `http://127.0.0.1:8765`. Python edits restart that server; browser edits refresh its page without reloading the models.

## Account sign-in

Account sync is implemented, and Google is configured for launch. Production and preview builds enable its button; the first real account sign-in still needs verification. Practice history also stays on the device. The sign-in options are:

- **Email link:** Choose an email provider such as Resend or Postmark and a domain you control. The domain owner must authorize the provider and add its DNS verification records; a `*.vercel.app` address cannot be verified as the sending domain. Configure [custom SMTP in Supabase](https://supabase.com/docs/guides/auth/auth-smtp) and verify delivery to a public address. Supabase's default sender is limited to project-team addresses. Only after verification, set `SUPABASE_EMAIL_ENABLED=true` for the app build. It defaults to false.
- **Google (launch choice):** In the chosen Google Cloud project, configure the OAuth consent screen and create a **Web application** OAuth client. Add `https://piano-duet.vercel.app` as an authorized JavaScript origin and `https://tbiuoywaqiiqjeezrybs.supabase.co/auth/v1/callback` as an authorized redirect URI. Use the `openid`, `email` and `profile` scopes. Add any preview origins individually if needed; Google does not accept wildcard origins. Put the client ID and secret in the Supabase Google provider configuration and enable the provider. `SUPABASE_GOOGLE_ENABLED=true` enables the button in production and preview builds; it defaults to false. Google sign-in needs no sign-in email. See [Supabase's Google setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google).
- **Apple later:** Use an Apple Developer account to configure the app identifier, web Services ID, signing key and redirect for [Sign in with Apple](https://supabase.com/docs/guides/auth/social-sign-in/auth-apple), then configure it in Supabase and the app.

## Checks

```sh
make check     # lint, Python, TypeScript and browser tests
make lint      # ruff
make test      # pytest, Node and Playwright tests
make benchmark # the real models on synthetic audio
```

The basic `make check` suite does not download model weights. CI also downloads and caches the pinned published models for parity and end-to-end microphone checks. Full-model comparisons and their requirements are described in [Browser inference measurements](/docs/how/performance/).

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
