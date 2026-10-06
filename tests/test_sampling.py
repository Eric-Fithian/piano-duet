from itertools import pairwise
from threading import Event

import mlx.core as mx
import pytest
from ariautils.tokenizer import AbsTokenizer

from piano_duet.difficulty import PerformanceLimits
from piano_duet.generation import PianoGenerator, repetitive_short_notes
from piano_duet.notes import Note
from piano_duet.phrasing import PhraseEnding


def main():
    raise SystemExit(pytest.main([__file__]))


class CollapsedModel:
    def __init__(self):
        tokenizer = AbsTokenizer()
        self.seen = []
        self.logits = mx.full((tokenizer.vocab_size,), -100.0)
        self.logits[tokenizer.tok_to_id[("piano", 60, 80)]] = 100
        for duration, score in [(10, 100), (80, 90), (400, 80)]:
            self.logits[tokenizer.tok_to_id[("dur", duration)]] = score
        for token in tokenizer.onset_tokens:
            self.logits[tokenizer.tok_to_id[token]] = 100 - token[1] / 10
        self.logits[tokenizer.tok_to_id[tokenizer.time_tok]] = 0

    def load_weights(self, *args, **kwargs):
        pass

    def eval(self):
        pass

    def parameters(self):
        return {}

    def setup_cache(self, *args, **kwargs):
        pass

    def __call__(self, tokens, *args, **kwargs):
        if tokens.shape[-1] == 1:
            self.seen.append(tokens[0, 0].item())
        return self.logits[None, None, :]


@pytest.fixture
def generator(monkeypatch):
    monkeypatch.setattr("piano_duet.generation.create_model", CollapsedModel)
    monkeypatch.setattr("piano_duet.generation.nn.quantize", lambda *args, **kwargs: None)
    return PianoGenerator()


def prompt():
    return [
        Note(pitch=60, start=0, duration=0.4, velocity=80),
        Note(pitch=60, start=4.9, duration=0.4, velocity=80),
    ]


def test_tiny_duration_collapse_is_blocked_before_sampling(generator):
    ending = PhraseEnding(2, beat=0.5, tonic=0, pitch_classes=(0, 2, 4, 5, 7, 9, 11))
    notes = list(
        generator.sample_notes(
            prompt(), ending, 0.95, None, 24, None, (0, 2, 4, 5, 7, 9, 11), difficulty=5
        )
    )
    assert all(note.duration >= 0.08 for note in notes)
    assert any(note.duration >= 0.4 for note in notes)
    assert generator.dim_id in generator.model.seen
    assert generator.time_id in generator.model.seen
    assert all(b.start - a.start >= 0.059 for a, b in pairwise(notes))


@pytest.mark.parametrize("level", range(1, 6))
def test_model_cannot_sample_faster_than_selected_difficulty(generator, level):
    ending = PhraseEnding(5, beat=0.5, tonic=0, pitch_classes=(0, 2, 4, 5, 7, 9, 11))
    notes = list(
        generator.sample_notes(
            prompt(), ending, 0.95, None, 24, None, (0, 2, 4, 5, 7, 9, 11), difficulty=level
        )
    )
    limits = PerformanceLimits(level, beat=0.5)
    assert len(notes) >= 8
    assert all(b.start - a.start >= limits.gap / 1000 - 0.001 for a, b in pairwise(notes))
    assert all(note.duration >= max(0.08, limits.duration_floor / 1000) for note in notes)


def test_short_loop_detection_preserves_varied_runs_and_normal_repetition():
    clicks = [Note(pitch=60 + i % 2, start=i * 0.15, duration=0.08, velocity=80) for i in range(12)]
    assert repetitive_short_notes(clicks)
    melody = [note.model_copy(update={"pitch": 60 + i}) for i, note in enumerate(clicks)]
    assert not repetitive_short_notes(melody)
    held = [note.model_copy(update={"duration": 0.4}) for note in clicks]
    assert not repetitive_short_notes(held)


def test_stop_discards_buffered_ending_notes(generator):
    cancel = Event()
    response = generator.generate(
        prompt(), seconds=2, cancel=cancel, pitch_classes=(0, 2, 4, 5, 7, 9, 11), tonic=0
    )
    assert next(response).pitch == 60
    cancel.set()
    assert list(response) == []


if __name__ == "__main__":
    main()
