class WeightedPhrase:
    """Stands in for Aria: each note follows the curriculum's practice weights alone."""

    def __init__(self, rng, context=None):
        self.rng = rng
        self.context = context
        self.notes = []

    def note(self, onset, pitches, durations):
        if self.notes:
            last_onset, last_pitch, _ = self.notes[-1]
            assert onset >= last_onset - 1e-9
            assert abs(onset - last_onset) > 1e-9 or min(pitches) > last_pitch
        assert pitches and durations
        assert all(weight > 0 for weight in [*pitches.values(), *durations.values()])
        pitch = self.rng.choices(list(pitches), weights=list(pitches.values()))[0]
        duration = self.rng.choices(list(durations), weights=list(durations.values()))[0]
        self.notes.append((onset, pitch, duration))
        return pitch, duration

    def chord_chance(self, pitches):
        assert pitches
        return 0.3
