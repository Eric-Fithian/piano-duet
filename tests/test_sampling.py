from itertools import pairwise
from random import Random
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


class FavouriteModel:
    """Prefers C5 and a four-second note, which the reading constraints never offer."""

    def __init__(self, tokenizer):
        self.tokenizer = tokenizer
        self.fed = []
        self.calls = 0

    def setup_cache(self, *args, **kwargs):
        self.fed = []

    def __call__(self, tokens, positions, offset, max_kv_pos):
        assert offset == len(self.fed) == positions[0].item()
        self.fed += tokens[0].tolist()
        self.calls += 1
        logits = mx.zeros((1, tokens.shape[1], self.tokenizer.vocab_size))
        logits[:, :, self.tokenizer.tok_to_id[("piano", 72, 80)]] = 50
        logits[:, :, self.tokenizer.tok_to_id[("dur", 4000)]] = 50
        return logits


def test_constrained_phrases_write_only_the_offered_notes_at_the_given_times(generator):
    tokenizer = generator.tokenizer
    generator.model = FavouriteModel(tokenizer)
    phrase = generator.phrase(Random(3))
    written = [
        phrase.note(0, {60: 1.0, 62: 1.0}, {0.5: 1.0, 1.0: 1.0}),
        phrase.note(0, {64: 1.0, 67: 1.0}, {0.5: 1.0}),
        phrase.note(6.2, {62: 1.0}, {1.25: 1.0, 2.0: 1.0}),
    ]
    assert written[0][0] in (60, 62) and written[0][1] in (0.5, 1.0)
    assert written[1][0] in (64, 67) and written[1][1] == 0.5
    assert written[2][0] == 62 and written[2][1] in (1.25, 2.0)
    phrase.advance()
    tokens = [tokenizer.id_to_tok[i] for i in generator.model.fed]
    assert tokens[:2] == [("prefix", "instrument", "piano"), tokenizer.bos_tok]
    timing = [t for t in tokens if t == tokenizer.time_tok or (isinstance(t, tuple) and t[0] == "onset")]
    assert timing == [("onset", 0), ("onset", 0), tokenizer.time_tok, ("onset", 1200)]
    assert [t[1] for t in tokens if isinstance(t, tuple) and t[0] == "dur"] == [
        round(seconds * 1000) for _, seconds in written
    ]


def test_a_phrase_continues_its_context_from_where_the_context_ends(generator):
    tokenizer = generator.tokenizer
    generator.model = FavouriteModel(tokenizer)
    context = {"notes": [{"pitch": 60, "start": 0, "duration": 1, "velocity": 76, "staff": "treble", "finger": 1},
                         {"pitch": 64, "start": 3, "duration": 1, "velocity": 76, "staff": "treble"}], "end": 4.5}
    phrase = generator.phrase(Random(1), context)
    phrase.note(0, {62: 1.0}, {1.0: 1.0})
    phrase.note(1, {65: 1.0}, {1.0: 1.0})
    phrase.advance()
    tokens = [tokenizer.id_to_tok[i] for i in generator.model.fed]
    assert [t[1] for t in tokens if isinstance(t, tuple) and t[0] == "piano"] == [60, 64, 62, 65]
    timing = [t for t in tokens if t == tokenizer.time_tok or (isinstance(t, tuple) and t[0] == "onset")]
    assert timing == [("onset", 0), ("onset", 3000), ("onset", 4500), tokenizer.time_tok, ("onset", 500)]
    with pytest.raises(ValueError, match="end after"):
        generator.phrase(Random(1), {**context, "end": 2})


def test_fixed_durations_skip_the_model_and_weights_steer_free_choices(generator):
    generator.model = FavouriteModel(generator.tokenizer)
    phrase = generator.phrase(Random(0))
    for beat in range(4):
        assert phrase.note(beat, {60 + beat: 1.0}, {1.0: 1.0}) == (60 + beat, 1.0)
    # Aria still chooses each fixed note's velocity, but a single duration needs no model call.
    assert generator.model.calls == 4
    choices = {phrase.note(4 + i, {60: 1.0, 62: 1e9}, {1.0: 1.0})[0] for i in range(20)}
    assert choices == {62}
    with pytest.raises(ValueError, match="low to high"):
        phrase.note(23, {60: 1.0}, {1.0: 1.0})
    with pytest.raises(ValueError, match="time order"):
        phrase.note(2, {60: 1.0}, {1.0: 1.0})
    with pytest.raises(ValueError, match="positive weights"):
        phrase.note(30, {60: 0.0, 62: 1.0}, {1.0: 1.0})


if __name__ == "__main__":
    main()
