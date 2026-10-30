"""Transcribes recorded piano (YouTube audio) with Transkun 2.0 (Yan & Duan, 2024).

On synthetic renders of ASAP performances it found 99% of onsets against 93% for the live model,
at under a tenth of real time on the M4 Pro (.cache/amt-bench/RESULTS.md).
"""

import argparse
import math
import time
from collections.abc import Callable
from importlib.resources import files
from threading import Event

import moduleconf
import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly

from piano_duet.notes import Note
from piano_duet.score_import import ScoreError

SAMPLE_RATE = 44100
# Transkun matches its CPU accuracy on MPS at about 70% of the CPU time.
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("audio")
    args = parser.parse_args()
    audio, rate = sf.read(args.audio, dtype="float32")
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    audio = resample_poly(audio, SAMPLE_RATE, rate).astype(np.float32)
    transcriber = RecordingTranscriber()
    started = time.perf_counter()
    notes = transcriber.transcribe(audio, Event(), lambda progress: None)
    print(f"{len(notes)} notes in {time.perf_counter() - started:.1f}s on {DEVICE}")


class RecordingTranscriber:
    def __init__(self):
        pretrained = files("transkun") / "pretrained"
        conf = moduleconf.parseFromFile(str(pretrained / "2.0.conf"))
        self.model = conf["Model"].module.TransKun(conf=conf["Model"].config).to(DEVICE)
        checkpoint = torch.load(str(pretrained / "2.0.pt"), map_location=DEVICE, weights_only=False)
        self.model.load_state_dict(checkpoint["state_dict"])
        self.model.eval()
        if self.model.fs != SAMPLE_RATE:
            raise ValueError(f"Transkun expects {self.model.fs} Hz audio")

    @torch.inference_mode()
    def transcribe(self, audio: np.ndarray, cancel: Event, on_progress: Callable[[float], None]) -> list[Note]:
        if audio.ndim != 1 or not np.isfinite(audio).all():
            raise ValueError(f"Expected finite mono {SAMPLE_RATE} Hz PCM")
        model = self.model
        # Mirrors the padding and hop in TransKun.transcribe so progress counts its segments.
        pad = math.ceil((model.segmentSizeInSecond - model.segmentHopSizeInSecond) * SAMPLE_RATE)
        step = math.ceil(model.segmentHopSizeInSecond * SAMPLE_RATE / model.hopSize) * model.hopSize
        segments = math.ceil((len(audio) + 2 * pad) / step)
        frames = model.__class__.transcribeFrames
        done = 0

        # TransKun.transcribe offers no progress or cancellation hook, so they wrap each segment it decodes.
        def segment(*args, **kwargs):
            nonlocal done
            if cancel.is_set():
                raise ScoreError("The import was cancelled")
            result = frames(model, *args, **kwargs)
            done += 1
            on_progress(min(1, done / segments))
            return result

        model.transcribeFrames = segment
        events = model.transcribe(torch.from_numpy(audio[:, None]).to(DEVICE), discardSecondHalf=False)
        return to_notes(events, len(audio) / SAMPLE_RATE)


def to_notes(events, seconds):
    """Key-down durations without the sustain pedal, the form MIDI2ScoreTransformer was trained on."""
    notes = []
    for event in sorted((event for event in events if event.pitch > 0), key=lambda event: (event.start, event.pitch)):
        end = min(seconds, event.end)
        if end > event.start:
            notes.append(Note(pitch=event.pitch, start=event.start, duration=end - event.start,
                              velocity=max(1, int(event.velocity))))
    return notes


if __name__ == "__main__":
    main()
