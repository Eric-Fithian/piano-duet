from dataclasses import dataclass
from math import ceil


def main():
    for level, settings in enumerate(LEVELS, 1):
        print(f"{level}: {settings.name}, up to {settings.chord_notes} notes per attack")


@dataclass(frozen=True)
class Difficulty:
    name: str
    low: int
    high: int
    chord_notes: int
    notes_per_hand: int
    hand_span: int
    hand_leap: int
    attack_beats: float
    attack_floor_ms: int
    duration_fraction: float


LEVELS = (
    Difficulty(
        name="Gentle",
        low=48,
        high=76,
        chord_notes=2,
        notes_per_hand=1,
        hand_span=5,
        hand_leap=5,
        attack_beats=1,
        attack_floor_ms=450,
        duration_fraction=0.75,
    ),
    Difficulty(
        name="Easy",
        low=43,
        high=79,
        chord_notes=3,
        notes_per_hand=2,
        hand_span=7,
        hand_leap=7,
        attack_beats=0.75,
        attack_floor_ms=300,
        duration_fraction=0.6,
    ),
    Difficulty(
        name="Moderate",
        low=36,
        high=84,
        chord_notes=4,
        notes_per_hand=3,
        hand_span=12,
        hand_leap=12,
        attack_beats=0.5,
        attack_floor_ms=180,
        duration_fraction=0.45,
    ),
    Difficulty(
        name="Advanced",
        low=28,
        high=96,
        chord_notes=6,
        notes_per_hand=4,
        hand_span=12,
        hand_leap=19,
        attack_beats=0.25,
        attack_floor_ms=100,
        duration_fraction=0.25,
    ),
    Difficulty(
        name="Expert",
        low=21,
        high=108,
        chord_notes=8,
        notes_per_hand=5,
        hand_span=14,
        hand_leap=24,
        attack_beats=0.125,
        attack_floor_ms=70,
        duration_fraction=0,
    ),
)


class PerformanceLimits:
    def __init__(self, level, beat):
        if type(level) is not int or not 1 <= level <= len(LEVELS):
            raise ValueError("Reply difficulty must be an integer from 1 to 5")
        self.settings = LEVELS[level - 1]
        self.gap = (
            ceil(max(self.settings.attack_floor_ms, beat * self.settings.attack_beats * 1000) / 10)
            * 10
        )
        self.duration_floor = ceil(self.gap * self.settings.duration_fraction / 10) * 10
        self.group_start = None
        self.chord = []
        self.hand_groups = {}
        self.last_attack = {}

    def in_range(self, pitch):
        return self.settings.low <= pitch <= self.settings.high

    def hand_can_move(self, pitch):
        previous = self.hand_groups.get(pitch >= 60)
        return (
            previous is None or min(abs(pitch - p) for p in previous[1]) <= self.settings.hand_leap
        )

    def chord_can_add(self, pitch):
        if len(self.chord) >= self.settings.chord_notes or pitch in self.chord:
            return False
        hand = [p for p in self.chord if (p >= 60) == (pitch >= 60)]
        if len(hand) >= self.settings.notes_per_hand:
            return False
        if hand and max(*hand, pitch) - min(*hand, pitch) > self.settings.hand_span:
            return False
        return bool(hand) or self.hand_can_move(pitch)

    def windows(self, pitch, earliest):
        if not self.in_range(pitch):
            return []
        earliest = max(earliest, self.last_attack.get(pitch, -1000) + 60)
        if self.group_start is None:
            return [(earliest, float("inf"))]
        result = []
        # A small onset window preserves rolled chords while separating them from fast runs.
        if earliest <= self.group_start + 40 and self.chord_can_add(pitch):
            result.append((earliest, self.group_start + 40))
        if self.hand_can_move(pitch):
            result.append((max(earliest, self.group_start + self.gap), float("inf")))
        return result

    def record(self, pitch, onset):
        if self.group_start is None or onset > self.group_start + 40:
            self.group_start = onset
            self.chord = []
        self.chord.append(pitch)
        hand = pitch >= 60
        if hand not in self.hand_groups or self.hand_groups[hand][0] != self.group_start:
            self.hand_groups[hand] = (self.group_start, [])
        self.hand_groups[hand][1].append(pitch)
        self.last_attack[pitch] = onset


if __name__ == "__main__":
    main()
