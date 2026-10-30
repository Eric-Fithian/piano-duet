import json
import time
from fractions import Fraction
from threading import Event

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from piano_duet.assets import CACHE, SAMPLES, require_assets
from piano_duet.notes import Note
from piano_duet.server import DuetEngine
from piano_duet.transcription import NOTE_THRESHOLD, SAMPLE_RATE


def main():
    require_assets()
    audio, expected = example_audio()
    output = CACHE / "benchmark"
    output.mkdir(parents=True, exist_ok=True)
    sf.write(output / "phrase.wav", audio, SAMPLE_RATE, subtype="PCM_16")
    engine = DuetEngine()
    results = []
    for iteration, gain in enumerate((1.0, 0.3, 0.1)):
        events = []
        started = time.perf_counter()
        engine.respond(audio * gain, "benchmark", 5, 0.95, NOTE_THRESHOLD, events.append, Event())
        heard = next(event for event in events if event["type"] == "heard")["notes"]
        matched = set()
        for note in heard:
            candidates = [
                i
                for i, target in enumerate(expected)
                if i not in matched
                and target.pitch == note["pitch"]
                and abs(target.start - note["start"]) < 0.1
            ]
            if candidates:
                matched.add(min(candidates, key=lambda i: abs(expected[i].start - note["start"])))
        precision = len(matched) / len(heard) if heard else 0
        recall = len(matched) / len(expected)
        report = {
            **events[-1],
            "iteration": iteration + 1,
            "input_gain": gain,
            "wall_seconds": round(time.perf_counter() - started, 3),
            "heard": len(heard),
            "expected": len(expected),
            "precision": round(precision, 3),
            "recall": round(recall, 3),
        }
        results.append(report)
        print(json.dumps(report, indent=2), flush=True)
        if precision < 0.85 or recall < 0.85:
            raise RuntimeError("Piano transcription failed the sampled chord-and-melody check")
        if report["first_note_ms"] > 3000:
            raise RuntimeError("First-note latency exceeds the three-second benchmark limit")
    (output / "metrics.json").write_text(json.dumps(results, indent=2) + "\n")


def example_audio():
    melody = [60, 64, 67, 69, 67, 64, 62, 60]
    notes = [
        Note(pitch=pitch, start=0.2 + i * 0.45, duration=0.36, velocity=85)
        for i, pitch in enumerate(melody)
    ]
    notes += [Note(pitch=pitch, start=0.2, duration=1.5, velocity=70) for pitch in (48, 55, 52)]
    notes += [Note(pitch=pitch, start=2, duration=1.5, velocity=70) for pitch in (43, 50, 53)]
    manifest = json.loads((SAMPLES / "manifest.json").read_text())
    audio = np.zeros(5 * SAMPLE_RATE, dtype=np.float32)
    for note in notes:
        entry = min(manifest, key=lambda entry: abs(entry["pitch"] - note.pitch))
        sample, rate = sf.read(SAMPLES / entry["file"], dtype="float32")
        if sample.ndim == 2:
            sample = sample.mean(axis=1)
        ratio = Fraction(
            SAMPLE_RATE / (rate * 2 ** ((note.pitch - entry["pitch"]) / 12))
        ).limit_denominator(1000)
        sample = resample_poly(sample, ratio.numerator, ratio.denominator)
        sustain = round(note.duration * SAMPLE_RATE)
        release = round(0.18 * SAMPLE_RATE)
        sample = sample[: sustain + release].copy()
        sample[sustain:] *= np.geomspace(1, 0.0001, len(sample) - sustain)
        sample *= (note.velocity / 127) ** 1.5 * 0.65
        start = round(note.start * SAMPLE_RATE)
        audio[start : start + len(sample)] += sample
    if np.max(np.abs(audio)) > 1:
        raise ValueError("Benchmark sample unexpectedly clips")
    return audio, notes


if __name__ == "__main__":
    main()
