from itertools import pairwise
from statistics import median

from piano_duet.notes import Note


def main():
    print(
        "Reply length is a target; endings follow complete chords, pauses, and tonal resolutions."
    )


def estimate_beat(notes):
    starts = []
    for note in sorted(notes, key=lambda note: note.start):
        if not starts or note.start - starts[-1] > 0.04:
            starts.append(note.start)
    intervals = [b - a for a, b in pairwise(starts) if 0.1 <= b - a <= 1.5]
    return max(0.3, min(1.0, median(intervals))) if intervals else 0.5


class PhraseEnding:
    def __init__(self, target, beat=0.5, tonic=None, pitch_classes=None):
        self.target = target
        self.beat = beat
        self.tonic = tonic
        third = (
            3 if pitch_classes and tonic is not None and (tonic + 3) % 12 in pitch_classes else 4
        )
        self.triad = (
            {(tonic + interval) % 12 for interval in (0, third, 7)} if tonic is not None else set()
        )
        self.horizon = target + max(3, min(6, target * 0.6))
        self.tail_start = max(0.5, target * 0.65)
        self.notes = []
        self.group_start = 0
        self.released = 0
        self.candidates = []
        self.done = False
        self.reason = None

    def feed(self, note: Note):
        if self.done:
            raise RuntimeError("Cannot extend a completed reply")
        if self.notes and note.start < self.notes[-1].start:
            raise ValueError("Reply notes must arrive in onset order")
        released = []
        if self.notes and note.start - self.notes[self.group_start].start > 0.04:
            group = self.notes[self.group_start :]
            score, pause, resolution = self.boundary(group, note.start)
            if group[0].start >= self.tail_start:
                self.candidates.append((score, len(self.notes)))
                long_enough = (
                    group[0].start + min(max(n.duration for n in group), self.beat)
                    >= self.target * 0.85
                )
                if long_enough and (pause or resolution):
                    self.done = True
                    self.reason = "pause" if pause else "resolution"
                    return self.release(len(self.notes))
            else:
                released = self.release(len(self.notes))
            self.group_start = len(self.notes)
        if not self.done:
            self.notes.append(note)
        return released

    def boundary(self, group, next_start):
        start = group[0].start
        pitches = {note.pitch % 12 for note in group}
        melody = max(group, key=lambda note: note.pitch).pitch % 12
        longest = max(note.duration for note in group)
        sounding = [note for note in self.notes if note.start + note.duration > start]
        bass = min(sounding, key=lambda note: note.pitch).pitch % 12
        prior = self.notes[: self.group_start]
        prior_start = prior[-1].start if prior else -1
        prior_melody = (
            max((note.pitch for note in prior if note.start >= prior_start - 0.04), default=-100)
            % 12
        )
        tonic_chord = self.tonic in pitches and len(pitches) >= 2 and pitches <= self.triad
        tonic_melody = melody == self.tonic
        step_resolution = (
            self.tonic is not None
            and tonic_melody
            and prior_melody in {(self.tonic - 1) % 12, (self.tonic + 2) % 12}
        )
        held = longest >= self.beat * 0.7
        tonal_score = (
            3 * tonic_chord + 2 * tonic_melody + step_resolution + 0.5 * (bass == self.tonic)
        )
        release = max(note.start + note.duration for note in self.notes)
        silence = next_start - release
        onset_gap = next_start - start
        real_pause = silence >= max(0.15, self.beat * 0.35)
        spacious = onset_gap >= self.beat * 1.5
        settled = not self.triad or melody in self.triad or silence >= self.beat * 2.5
        pause = real_pause and onset_gap >= self.beat and settled
        resolution = held and (tonic_chord or step_resolution or (tonic_melody and spacious))
        duration_score = min(2, longest / self.beat) * 0.6
        proximity = abs(start + min(longest, self.beat) - self.target) / self.beat
        score = tonal_score + duration_score + 3 * pause + spacious - 0.3 * proximity
        return score, pause, resolution

    def release(self, end):
        result = self.notes[self.released : end]
        self.released = end
        return result

    def finish(self, model_ended=False):
        if self.done:
            return []
        self.done = True
        if model_ended:
            self.reason = "model"
            return self.release(len(self.notes))
        # Only completed onset groups are candidates; the token budget may end inside a chord.
        if self.candidates:
            self.reason = "best_boundary"
            _, end = max(self.candidates)
            return self.release(end)
        self.reason = "short_phrase"
        return self.release(self.group_start or len(self.notes))


if __name__ == "__main__":
    main()
