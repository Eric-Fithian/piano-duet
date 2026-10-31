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

For account and sync tests, start Docker, install the Supabase CLI, run `supabase start`, then `npm run test:sync`. The tests use local accounts and Mailpit; they do not need a hosted project or provider credentials. To enable sign-in in a local browser, supply an untracked `site/app/sync-config.json` containing `{"url":"<local API URL>","anonKey":"<local anon key>"}` using the values from `supabase status`.

1. Branch from `main`.
2. Make the change, with tests. Python tests live in `tests/test_*.py`, browser-module tests in `tests/*.test.mjs`, TypeScript parity tests in `tests/core/`, and browser storage tests in `tests/web/`. These tests do not need the downloaded models.
3. Run `make check`, which is what CI runs. Run `make site-build` if you touched `site/`.
4. Update the documentation in `site/src/content/docs/` if behaviour changed.
5. Open a pull request. CI must pass before it can merge, and Vercel comments with a preview link for website changes.

Keep each pull request to one change, and write the description around *why* it is needed.

## Hosted account rollout

The rollout has not been run. After approving and completing `supabase login`, use the following command from the project root with a Free-plan organization slug. It also requires Node.js 24+, the Supabase CLI, and the Vercel CLI already authenticated to the `eric-fithians-projects` scope with access to `piano-duet`.

```sh
node scripts/rollout-sync.mjs --organization <organization-slug>
```

The script verifies the organization's plan and the Vercel target, then creates a project named `piano-duet` in `us-east-2`. It generates a database password in memory, links the project, runs `supabase db push`, and changes the requested Supabase Auth settings. It reads the CLI's saved login from the Mac keychain; macOS may request keychain access. A `SUPABASE_ACCESS_TOKEN` environment variable can be used instead. No token, database password, or service-role key is written into the repository. Supabase CLI may store the database password in the keychain when linking. If creation succeeds but linking is interrupted before the password is saved, reset the database password in Supabase before continuing with the existing-project command.

To use an existing project in the same Free-plan organization, set its database password in `SUPABASE_DB_PASSWORD` in the process environment and add `--project-ref <project-ref>` to the command. `--project-name`, `--region`, and `--vercel-scope` override the defaults. The script refuses to create a duplicate project name or overwrite existing `SUPABASE_URL` or `SUPABASE_ANON_KEY` variables in Vercel; inspect any existing values and targets before resolving a conflict. A failed command can leave earlier changes in place, so inspect the project and use `--project-ref` when resuming.

Auth is configured for `https://piano-duet.vercel.app` and `https://piano-duet-*-eric-fithians-projects.vercel.app/**` (or the specified Vercel scope), email sign-in, and disabled Apple and Google providers. The script replaces the project's redirect allowlist and disables those providers even when linking an existing project. It does not configure SMTP or provider credentials. Supabase's default email service restricts recipients and is rate limited; production sign-in for the public requires a separately configured SMTP provider. Production and previews use the same Supabase project, so preview builds can access real account data subject to the same row-level security rules.

The script adds the public project URL and anon key to both Vercel environments. The static build writes `dist/sync-config.json` from `SUPABASE_URL` and `SUPABASE_ANON_KEY`; neither value belongs in git, and a service-role key must never be used. The build fails if only one value is supplied. With neither value, it omits the file and the app reports that account sync is unavailable. A new production or preview deployment is needed after changing Vercel variables; the rollout script does not deploy. The config is fetched at runtime and is excluded from the offline app-shell cache. The generated config does not enable Apple or Google buttons; update the build to add a `providers` array only after those providers and their credentials are configured.

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
