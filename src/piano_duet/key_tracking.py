from dataclasses import dataclass

import numpy as np

from piano_duet.notes import Note

# Krumhansl–Kessler pitch-class profiles, also published in music21's key analysis docs.
PROFILES = {
    "major": [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    "minor": [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
}
INTERVALS = {"major": (0, 2, 4, 5, 7, 9, 11), "minor": (0, 2, 3, 5, 7, 8, 10)}
TONICS = {
    "major": ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"),
    "minor": ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"),
}
LETTERS = "CDEFGAB"
NATURALS = (0, 2, 4, 5, 7, 9, 11)


def main():
    tracker = KeyTracker()
    notes = [
        Note(pitch=p, start=i * 0.5, duration=0.4, velocity=80)
        for i, p in enumerate([60, 64, 67, 65, 69, 71, 62, 60])
    ]
    print(tracker.observe(notes))


@dataclass(frozen=True)
class MusicalKey:
    tonic: int
    mode: str

    @property
    def pitch_classes(self):
        return tuple((self.tonic + interval) % 12 for interval in INTERVALS[self.mode])

    @property
    def name(self):
        tonic = TONICS[self.mode][self.tonic].replace("b", "♭").replace("#", "♯")
        return f"{tonic} {self.mode}"

    def to_dict(self):
        tonic = TONICS[self.mode][self.tonic]
        first = LETTERS.index(tonic[0])
        spellings = []
        for index, pitch in enumerate(self.pitch_classes):
            letter = (first + index) % 7
            alteration = (pitch - NATURALS[letter] + 6) % 12 - 6
            accidental = "#" * alteration if alteration > 0 else "b" * -alteration
            spellings.append(LETTERS[letter] + accidental)
        return {
            "name": self.name,
            "tonic": self.tonic,
            "mode": self.mode,
            "signature": tonic + ("m" if self.mode == "minor" else ""),
            "pitch_classes": list(self.pitch_classes),
            "scale_names": spellings,
        }


KEYS = tuple(MusicalKey(tonic, mode) for mode in INTERVALS for tonic in range(12))
KEY_PROFILES = np.array([np.roll(PROFILES[key.mode], key.tonic) for key in KEYS])
CENTERED_PROFILES = KEY_PROFILES - KEY_PROFILES.mean(axis=1, keepdims=True)
NORMALIZED_PROFILES = CENTERED_PROFILES / np.linalg.norm(CENTERED_PROFILES, axis=1, keepdims=True)
SCALE_MASKS = np.array([[pitch in key.pitch_classes for pitch in range(12)] for key in KEYS])


def pitch_histogram(notes):
    histogram = np.zeros(12)
    for note in notes:
        # Cap sustain and soften velocity weighting so resonance cannot dominate the key.
        weight = min(note.duration, 1.5) ** 0.5 * (0.5 + note.velocity / 254)
        histogram[note.pitch % 12] += weight
    return histogram / histogram.sum()


def key_scores(histogram):
    centered = histogram - histogram.mean()
    norm = np.linalg.norm(centered)
    correlation = NORMALIZED_PROFILES @ centered / norm if norm > 1e-8 else np.zeros(24)
    coverage = SCALE_MASKS @ histogram
    return 0.6 * correlation + 0.8 * coverage


class KeyTracker:
    def __init__(self):
        self.current = None

    def observe(self, notes: list[Note]):
        if not notes:
            raise ValueError("Key detection requires at least one played note")
        scores = key_scores(pitch_histogram(notes))
        previous = self.current
        self.current = int(np.argmax(scores))
        alternatives = np.delete(scores, self.current)
        tentative = len(notes) < 6 or scores[self.current] - alternatives.max() < 0.08
        return {
            **KEYS[self.current].to_dict(),
            "tentative": bool(tentative),
            "changed": previous is not None and previous != self.current,
            "previous": KEYS[previous].name
            if previous is not None and previous != self.current
            else None,
        }


if __name__ == "__main__":
    main()
