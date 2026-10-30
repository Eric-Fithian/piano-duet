import json
from random import Random

from fake_phrase import WeightedPhrase

from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import compose_reading
from piano_duet.reading_stages import STAGES


def main():
    cases = []
    for stage in STAGES:
        for seed in (0, 7):
            context = None if seed == 0 else {
                "notes": [{"pitch": 60, "start": 0, "duration": 0.5, "velocity": 76}],
                "end": 0.5,
            }
            cases.append(record_composition(stage, seed, context))
    print(json.dumps(cases))


class DrawRandom(Random):
    def __init__(self, seed):
        super().__init__(seed)
        self.draws = []

    def random(self):
        value = super().random()
        self.draws.append({"method": "random", "value": value})
        return value

    def getrandbits(self, bits):
        value = super().getrandbits(bits)
        self.draws.append({"method": "getrandbits", "bits": bits, "value": value})
        return value


class RecordingRandom:
    def __init__(self, seed, events):
        self.generator = DrawRandom(seed)
        self.events = events

    def call(self, method, args, kwargs):
        before = len(self.generator.draws)
        value = getattr(self.generator, method)(*args, **kwargs)
        self.events.append({
            "type": "random", "method": method, "args": args, "kwargs": kwargs,
            "draws": self.generator.draws[before:], "value": value,
        })
        return value

    def random(self):
        return self.call("random", (), {})

    def choice(self, options):
        return self.call("choice", (options,), {})

    def choices(self, population, weights=None, *, k=1):
        return self.call("choices", (population,), {"weights": weights, "k": k})

    def sample(self, population, k):
        return self.call("sample", (population, k), {})

    def randrange(self, start, stop):
        return self.call("randrange", (start, stop), {})


class RecordingPhrase:
    def __init__(self, rng, context=None):
        self.rng = rng
        self.phrase = WeightedPhrase(rng, context)
        rng.events.append({"type": "phrase", "context": context})

    def note(self, onset, pitches, durations):
        start = len(self.rng.events)
        value = self.phrase.note(onset, pitches, durations)
        draws = self.rng.events[start:]
        del self.rng.events[start:]
        self.rng.events.append({
            "type": "note", "onset": onset, "pitches": list(pitches.items()),
            "durations": list(durations.items()), "random": draws, "value": value,
        })
        return value

    def chord_chance(self, pitches):
        value = self.phrase.chord_chance(pitches)
        self.rng.events.append({"type": "chord_chance", "pitches": pitches, "value": value})
        return value


def record_composition(stage, seed, context=None):
    progress = reading_progress([])
    progress["curriculum"].update(
        current=stage["id"], number=stage["number"], target=stage["id"],
        target_number=stage["number"], contexts=[],
    )
    events = []
    score = compose_reading(progress, RecordingRandom(seed, events), RecordingPhrase, context)
    return {"stage": stage, "progress": progress, "seed": seed, "context": context, "events": events, "score": score}


if __name__ == "__main__":
    main()
