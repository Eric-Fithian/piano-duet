from threading import Event
from types import SimpleNamespace

import mlx.core as mx
import pytest
from ariautils.tokenizer import AbsTokenizer

from piano_duet.learning import analyze_phrase, compare_performance, pitch_probabilities
from piano_duet.notes import Note


def main():
    raise SystemExit(pytest.main([__file__]))


def note(pitch, start=0, duration=0.4):
    return Note(pitch=pitch, start=start, duration=duration, velocity=80)


class PredictiveModel:
    def __init__(self, tokenizer):
        self.tokenizer = tokenizer
        self.seen = []
        self.cache_lengths = []

    def setup_cache(self, batch_size, max_seq_len, dtype):
        self.cache_lengths.append(max_seq_len)
        self.prefix = []

    def __call__(self, tokens, positions, offset, max_kv_pos):
        assert offset == len(self.prefix)
        values = tokens[0].tolist()
        self.prefix.extend(values)
        self.seen.extend(values)
        played = [self.tokenizer.id_to_tok[i] for i in self.prefix]
        pitches = [t[1] for t in played if isinstance(t, tuple) and t[0] == "piano"]
        expected = 62 if pitches and pitches[-1] == 61 else 60
        logits = mx.full((self.tokenizer.vocab_size,), -20.0)
        logits[self.tokenizer.tok_to_id[("piano", expected, 80)]] = 0
        return logits[None, None, :]


@pytest.fixture
def generator():
    tokenizer = AbsTokenizer()
    return SimpleNamespace(
        tokenizer=tokenizer,
        model=PredictiveModel(tokenizer),
        note_ids=[
            i
            for i, t in tokenizer.id_to_tok.items()
            if isinstance(t, tuple) and t[0] == "piano" and 21 <= t[1] <= 108 and t[2] > 0
        ],
    )


def analyze(generator, notes, threshold=0.98, cancel=None):
    return analyze_phrase(
        generator, notes, threshold, cancel or Event(), lambda detail, progress: None
    )


def test_predictions_use_original_prefix_and_preserve_timing(generator):
    original = [note(61, 0.3), note(66, 1.2, 0.7)]
    target, analysis = analyze(generator, original)
    assert [n.pitch for n in target] == [60, 62]
    assert [n.pitch for n in original] == [61, 66]
    assert target[1].start == pytest.approx(0.9)
    assert target[1].duration == 0.7 and target[1].velocity == 80
    assert analysis[0]["surprise"] == 1 - analysis[0]["probability"]
    seen = [generator.tokenizer.id_to_tok[i] for i in generator.model.seen]
    assert ("piano", 61, 80) in seen
    assert ("piano", 60, 80) not in seen


def test_future_notes_cannot_change_prior_probabilities(generator):
    _, a = analyze(generator, [note(61), note(66, 1)])
    _, b = analyze(generator, [note(61), note(79, 4)])
    assert a[0] == b[0]


def test_probability_sums_velocities_before_choosing_pitch(generator):
    logits = mx.full((generator.tokenizer.vocab_size,), -100.0)
    for token, probability in [
        (("piano", 60, 40), 0.3),
        (("piano", 60, 80), 0.3),
        (("piano", 61, 80), 0.4),
    ]:
        logits[generator.tokenizer.tok_to_id[token]] = mx.log(mx.array(probability))
    probabilities = pitch_probabilities(logits, generator)
    assert probabilities[60 - 21] == pytest.approx(0.6)
    assert probabilities.argmax() + 21 == 60


def test_threshold_can_preserve_every_played_note(generator):
    target, analysis = analyze(generator, [note(61), note(66, 1)], threshold=1)
    assert [n.pitch for n in target] == [61, 66]
    assert not any(row["changed"] for row in analysis)


def test_corrections_cannot_collapse_two_chord_notes_to_one_pitch(generator):
    target, analysis = analyze(generator, [note(59), note(60, 0.01)])
    assert [n.pitch for n in target] == [59, 60]
    assert analysis[0]["chord_collision"]


def test_long_phrases_score_every_note_with_bounded_context(generator):
    notes = [note(60, i * 0.5) for i in range(650)]
    target, analysis = analyze(generator, notes)
    assert len(target) == len(analysis) == 650
    assert max(generator.model.cache_lengths) < 1800
    assert analysis[-1]["index"] == 649


def test_cancel_does_not_return_a_partial_target(generator):
    cancel = Event()
    result = analyze_phrase(
        generator, [note(61), note(66, 1)], 0.98, cancel, lambda detail, progress: cancel.set()
    )
    assert result is None


def test_identical_playback_and_consistent_slower_tempo_score_full_marks():
    target = [note(p, i * 0.5) for i, p in enumerate([60, 64, 67, 62])]
    attempt = [n.model_copy(update={"start": n.start * 1.5 + 2}) for n in target]
    score = compare_performance(target, attempt)
    assert score["score"] == score["pitch_accuracy"] == score["rhythm_accuracy"] == 100
    assert score["tempo_percent"] == 67


def test_chord_order_and_small_attack_jitter_do_not_count_as_errors():
    target = [note(p) for p in (48, 60, 64, 67)]
    attempt = [note(p, 1 + i * 0.01) for i, p in enumerate((67, 48, 64, 60))]
    score = compare_performance(target, attempt)
    assert score["score"] == 100 and score["matched"] == 4


def test_wrong_missing_and_extra_notes_lower_score():
    target = [note(60), note(64, 0.5), note(67, 1), note(72, 1.5)]
    attempt = [note(60), note(65, 0.5), note(72, 1.5), note(80, 2)]
    score = compare_performance(target, attempt)
    assert score["matched"] == 2
    assert score["wrong"] == score["missing"] == score["extra"] == 1
    assert score["score"] <= 50


def test_irregular_rhythm_lowers_score_even_when_all_pitches_match():
    target = [note(60 + i, i * 0.5) for i in range(5)]
    attempt = [note(60 + i, start) for i, start in enumerate([0, 0.5, 1.1, 1.8, 3])]
    score = compare_performance(target, attempt)
    assert score["pitch_accuracy"] == 100
    assert score["rhythm_accuracy"] < 90
    assert score["score"] < 100


if __name__ == "__main__":
    main()
