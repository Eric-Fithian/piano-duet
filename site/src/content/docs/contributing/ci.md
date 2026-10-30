---
title: CI and releases
description: What runs on every pull request, how previews deploy, and how to cut a release.
---

## On every pull request

GitHub Actions runs [`ci.yml`](https://github.com/Eric-Fithian/piano-duet/blob/main/.github/workflows/ci.yml):

| Job | Runner | What it checks |
| --- | --- | --- |
| **Lint** | Ubuntu | `ruff check` on the Python, `shellcheck` on the installer |
| **Python tests** | macOS (Apple Silicon) | `pytest` with the locked dependencies, MLX included |
| **JavaScript tests** | Ubuntu | `node --test` on the browser modules |
| **Website** | Ubuntu | `astro check` and a production build of `site/` |

All four must pass before a pull request can merge into `main`. Dependencies are cached by `uv.lock` and `site/package-lock.json`, and a newer push to the same branch cancels the run in progress.

Vercel builds every pull request that touches `site/` and comments with a preview URL. Merging to `main` deploys the site to production.

## After merging

On every push to `main`, and weekly, the **Installer** job runs the [one-line installer](/start/install/) on a clean macOS runner, without downloading the models, and starts the installed command. This checks that a fresh install still works for new users.

## Keeping dependencies fresh

Dependabot opens grouped monthly pull requests for Python (`uv.lock`), the website's npm packages and the GitHub Actions versions. CodeQL scans the Python and JavaScript on every pull request.

## Releasing

1. Update `version` in `pyproject.toml` and merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The **Release** workflow checks that the tag matches `pyproject.toml`, runs the tests, and publishes a GitHub release with notes generated from the merged pull requests. Users get it with `piano-duet update`.
