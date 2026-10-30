"""Performance notes to a written score with MIDI2ScoreTransformer, run in its own environment."""

import hashlib
import os
import subprocess
import tempfile
from pathlib import Path

import httpx
from tqdm import tqdm

from piano_duet.notes import midi_bytes
from piano_duet.score_import import ScoreError, parse_musicxml

ROOT = Path(".cache/m2st")
PYTHON = ROOT / "venv/bin/python"
REPOSITORY = "https://github.com/TimFelixBeyer/MIDI2ScoreTransformer.git"
REVISION = "115432b"
PUBLIC_CHECKPOINT = ROOT / "MIDI2ScoreTF.ckpt"
PUBLIC_SHA256 = "7b8ec6e3da365b97443fb67a8f0b37d63997e93c152d665d43cb2011245db638"
PUBLIC_URL = f"https://github.com/TimFelixBeyer/MIDI2ScoreTransformer/releases/download/v0.0.1/{PUBLIC_CHECKPOINT.name}"
# Retrained separately and not published: synthetic pre-training on humanised PDMX scores, then real ASAP
# performances; four-seed weight average. On held-out ASAP test recordings through Transkun it ties the public
# checkpoint (paired per-piece MUSTER difference -0.40 [-1.41, +0.62]).
ASAP_SOUP_CHECKPOINT = ROOT / "pianoscore-soup4.ckpt"
ASAP_SOUP_SHA256 = "04bcc043079187bde8db1f74bad7c825bf9a5d8c56fc7d67998a8cddfe348bf5"
# The ASAP soup fine-tuned on 50k transcribed performances from PianoCoRe (alignment-matched notes only), mixed with
# ASAP and synthetic data. Paired per-piece MUSTER difference on held-out recordings through Transkun: -0.86
# [-1.70, -0.11] against the ASAP soup and -1.27 [-2.76, +0.13] against the public checkpoint; on held-out PianoCoRe
# transcriptions -0.97 and -1.98. Better timing, staff and time signatures; on very clean MIDI it still drops more
# notes than the public checkpoint.
PIANOCORE_CHECKPOINT = ROOT / "pianoscore-pianocore60-matched-seed0.ckpt"
PIANOCORE_SHA256 = "ea48a94f70992132b362852b717fba68d1cee87a2edf210ef5731f0fc93f756a"
# 120M parameters (the others are 33M), fine-tuned with 40% synthetic data, half of it from non-classical PDMX
# scores; two-seed weight average. Paired per-piece MUSTER difference against the PianoCoRe model: -0.63 [-1.02,
# -0.23] on held-out pop/film/game scores rendered and transcribed by Transkun; on held-out test sets -0.22 (PianoCoRe
# transcriptions), -0.24 (ASAP through Transkun), -1.30 (clean MIDI). Scoring on the Mac takes 2-3x as long.
MEDIUM_SOUP_CHECKPOINT = ROOT / "pianoscore-medium-pianocore45-syn40nonclassical-soup2.ckpt"
MEDIUM_SOUP_SHA256 = "c1bb45553989901920bc15215f6ffe0f6012e2ea18bca42f44c026a8a7c37fe3"
# Setup installs the public checkpoint; the first of these copied into ROOT is used, so reorder it to switch.
PREFERENCE = (MEDIUM_SOUP_CHECKPOINT, PIANOCORE_CHECKPOINT, ASAP_SOUP_CHECKPOINT, PUBLIC_CHECKPOINT)
CHECKSUMS = {PUBLIC_CHECKPOINT: PUBLIC_SHA256, ASAP_SOUP_CHECKPOINT: ASAP_SOUP_SHA256, PIANOCORE_CHECKPOINT: PIANOCORE_SHA256,
             MEDIUM_SOUP_CHECKPOINT: MEDIUM_SOUP_SHA256}
RUNNER = Path("src/piano_duet/midi_to_score.py")
# Versions verified together on Apple silicon; newer transformers changed the RoFormer internals the model extends.
REQUIREMENTS = ("torch==2.5.1", "pytorch_lightning==2.4.0", "transformers==4.44.2", "pretty_midi>=0.2.10", "numpy<2",
                "music21 @ git+https://github.com/TimFelixBeyer/music21@0ed70bb")
# Greedy decoding is ~60x faster on the M-series CPU than through MPS for this model.
DEVICE = "cpu"


def main():
    setup()
    print(f"MIDI2ScoreTransformer ready in {ROOT}")


def checkpoint():
    return next(path for path in PREFERENCE if path.exists())


def installed():
    return PYTHON.exists() and PUBLIC_CHECKPOINT.exists() and (ROOT / "repo/midi2scoretransformer").exists()


def setup():
    ROOT.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, "UV_CACHE_DIR": str(ROOT / "uv-cache")}
    if not (ROOT / "repo").exists():
        subprocess.run(["git", "clone", "-q", REPOSITORY, str(ROOT / "repo")], check=True)
    subprocess.run(["git", "-C", str(ROOT / "repo"), "checkout", "-q", REVISION], check=True)
    if not PYTHON.exists():
        subprocess.run(["uv", "venv", "-q", "--python", "3.11", str(ROOT / "venv")], check=True, env=environment)
    subprocess.run(["uv", "pip", "install", "-q", "--python", str(PYTHON), *REQUIREMENTS], check=True, env=environment)
    if not PUBLIC_CHECKPOINT.exists():
        download(PUBLIC_URL, PUBLIC_CHECKPOINT)
    for path, expected in CHECKSUMS.items():
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"{path} does not match the verified checkpoint")


def download(url, path):
    partial = path.with_suffix(".partial")
    with httpx.stream("GET", url, follow_redirects=True, timeout=60) as response:
        response.raise_for_status()
        with partial.open("wb") as file, tqdm(total=int(response.headers["content-length"]), unit="B",
                                               unit_scale=True, desc=path.name) as progress:
            for chunk in response.iter_bytes():
                file.write(chunk)
                progress.update(len(chunk))
    partial.rename(path)


def performance_tempo(notes, parsed):
    """The written beats spanned per second of performance, since the model writes no tempo."""
    beats = [note["beat"] for note in parsed["notes"]]
    seconds = max(note.start for note in notes) - min(note.start for note in notes)
    # build_song rewrites the note values of a tempo far outside TEMPO_RANGE rather than clamping it, which would change the timing.
    return round(60 * (max(beats) - min(beats)) / seconds) if seconds > 0 else 72


def performance_to_score(notes):
    if not installed():
        raise ScoreError("The score model is not installed. Run: uv run --frozen piano-duet setup")
    if len(notes) < 8:
        raise ScoreError("Too few piano notes were recognized to write a score")
    with tempfile.TemporaryDirectory(dir=ROOT) as folder:
        performance, score = Path(folder) / "performance.mid", Path(folder) / "score.musicxml"
        performance.write_bytes(midi_bytes(notes))
        # -I keeps the app's own modules (profile.py) from shadowing the standard library in that environment.
        result = subprocess.run([str(PYTHON), "-I", str(RUNNER), "--device", DEVICE, "--checkpoint", str(checkpoint()),
                                 str(performance), str(score)],
                                capture_output=True, text=True, check=False,
                                env={**os.environ, "HF_HOME": str(ROOT / "hf")})
        if result.returncode:
            raise RuntimeError(f"The score model failed: {result.stderr.strip().splitlines()[-1]}")
        parsed = parse_musicxml(score.read_bytes())
    return {**parsed, "bpm": performance_tempo(notes, parsed)}


if __name__ == "__main__":
    main()
