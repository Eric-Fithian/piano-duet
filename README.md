<p align="center">
  <img src="site/src/assets/logo.svg" width="72" height="72" alt="">
</p>

<h1 align="center">Piano Duet</h1>

<p align="center">
  Learn on your own piano with listening, sheet music and feedback on your device.
  <br>
  <a href="https://piano-duet.vercel.app"><strong>Website</strong></a> ·
  <a href="https://piano-duet.vercel.app/docs/start/install/">Install</a> ·
  <a href="https://piano-duet.vercel.app/docs/modes/reading/">Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/Eric-Fithian/piano-duet/actions/workflows/ci.yml"><img src="https://github.com/Eric-Fithian/piano-duet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f1aa1c" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-14%2B%20·%20Apple%20Silicon-38c6e8" alt="macOS 14+ on Apple Silicon">
</p>

![Reading mode: a four-bar score with played notes in green, a late note in red, and the cursor on the next note.](site/src/assets/screenshots/reading.png)

Play an acoustic or digital piano into your device's microphone. There's no on-screen keyboard and no MIDI cable. Piano Duet listens, writes fresh sheet music for you to read, and coaches your technique. Models run on your device.

- **Reading:** endless sight-reading that never repeats. Each four-bar score is composed by the [Aria](https://github.com/EleutherAI/aria) piano transformer under the rules of a 24-stage curriculum, aimed at the notes you miss most.
- **Drills:** scales, arpeggios, chords and Hanon, judged against your own steady tempo, with a chart of where each take drifted.
- **Library:** import MIDI or MusicXML, or turn a piano recording into a score, then play it with a cursor that waits for you.

Audio stays on your device and is not saved. Account sync is optional and does not include audio or model files. See [Privacy](https://piano-duet.vercel.app/docs/how/privacy/).

## Start

Open the [browser app](https://piano-duet.vercel.app/). Models and piano samples download on first use.

To install the Python reference, you need an Apple Silicon Mac with macOS 14 or later and about 8 GB of free disk space.

```sh
curl -fsSL https://piano-duet.vercel.app/install.sh | sh
piano-duet
```

The installer sets up [uv](https://docs.astral.sh/uv/), downloads the app and its models (about 3 GB, once), and adds a `piano-duet` command. `piano-duet update` updates it. See [Install](https://piano-duet.vercel.app/docs/start/install/) for installing from a clone.

## Develop

The browser rebuild is in progress. Its local event log, model cache and inference foundation can be developed with:

```sh
git clone https://github.com/Eric-Fithian/piano-duet.git && cd piano-duet
npm ci
npm ci --prefix site
npm run dev   # app at http://127.0.0.1:5173, docs at /docs
```

The browser practice modes and published model catalog are not ready yet. The existing Python application remains the working reference:

```sh
make setup   # dependencies and models
make dev     # hot reload at http://127.0.0.1:8765
make check   # lint and all tests, as CI runs them
make site    # the website at http://localhost:4321
```

Python edits restart the server, and HTML, CSS and JavaScript edits refresh the browser without reloading the models. CI runs lint, the Python tests on Apple Silicon, the JavaScript tests and the website build on every pull request. Vercel posts a preview of any website change. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture overview](https://piano-duet.vercel.app/docs/how/architecture/) to get started.

## Credits

Piano Duet builds on [Aria](https://github.com/EleutherAI/aria) (Apache 2.0), [High-resolution Piano Transcription](https://github.com/bytedance/piano_transcription) (MIT code; [Kong et al.'s checkpoint](https://doi.org/10.5281/zenodo.4034264) is CC BY 4.0), [Transkun](https://github.com/Yujia-Yan/Transkun) (MIT), [MIDI2ScoreTransformer](https://github.com/TimFelixBeyer/MIDI2ScoreTransformer), [VexFlow](https://github.com/vexflow/vexflow) (MIT) and piano samples from [tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments) (CC BY 3.0). Its interaction is inspired by Google Creative Lab's [A.I. Duet](https://github.com/googlecreativelab/aiexperiments-ai-duet). Setup downloads the models; they are not redistributed here. See [Credits](https://piano-duet.vercel.app/docs/credits/).

Released under the [MIT License](LICENSE).
