import pytest

from piano_duet.notes import Note
from piano_duet.phrasing import PhraseEnding, estimate_beat

C_MAJOR = (0, 2, 4, 5, 7, 9, 11)


def main():
    raise SystemExit(pytest.main([__file__]))


def note(pitch, start, duration=0.3):
    return Note(pitch=pitch, start=start, duration=duration, velocity=80)


def play(ending, notes, model_ended=False):
    result = []
    for item in notes:
        result.extend(ending.feed(item))
        if ending.done:
            break
    result.extend(ending.finish(model_ended))
    return result


def test_initial_notes_stream_before_the_ending_is_known():
    ending = PhraseEnding(5, tonic=0, pitch_classes=C_MAJOR)
    first = note(60, 0)
    assert ending.feed(first) == []
    assert ending.feed(note(62, 0.5)) == [first]
    assert not ending.done


def test_extends_past_target_to_finish_entire_tonic_chord():
    ending = PhraseEnding(2, tonic=0, pitch_classes=C_MAJOR)
    final_chord = [note(p, 2.4, 1.2) for p in (48, 60, 64, 67)]
    notes = [note(67, 0), note(71, 1.5)] + final_chord + [note(67, 4)]
    output = play(ending, notes)
    assert output[-4:] == final_chord
    assert max(n.start + n.duration for n in output) == pytest.approx(3.6)
    assert ending.reason in ("pause", "resolution")


def test_preserves_full_final_note_duration():
    ending = PhraseEnding(2, tonic=0, pitch_classes=C_MAJOR)
    held = note(60, 1.8, 2)
    output = play(ending, [note(67, 0), note(71, 1.4, 0.25), held, note(64, 3)])
    assert output[-1] == held
    assert output[-1].duration == 2
    assert output[-1].start + output[-1].duration > ending.target


def test_a_pause_on_a_leading_tone_waits_for_resolution():
    ending = PhraseEnding(2, tonic=0, pitch_classes=C_MAJOR)
    output = play(ending, [note(67, 0), note(71, 1.5, 0.25), note(60, 2.2, 1), note(64, 3.7)])
    assert output[-1].pitch == 60


def test_clear_pause_can_end_without_requiring_a_tonic_chord():
    ending = PhraseEnding(2, tonic=0, pitch_classes=C_MAJOR)
    output = play(ending, [note(60, 0), note(64, 1), note(67, 1.8, 0.4), note(60, 3)])
    assert output[-1].pitch == 67
    assert ending.reason == "pause"


def test_model_end_signal_preserves_its_complete_short_phrase():
    ending = PhraseEnding(5, tonic=0, pitch_classes=C_MAJOR)
    notes = [note(60, 0), note(64, 0.3), note(67, 0.6, 1.5)]
    assert play(ending, notes, model_ended=True) == notes
    assert ending.reason == "model"


def test_budget_end_chooses_a_complete_boundary_without_emitting_partial_last_chord():
    ending = PhraseEnding(2, tonic=0, pitch_classes=C_MAJOR)
    notes = [
        note(62, 0, 0.1),
        note(64, 0.5, 0.1),
        note(60, 1.5, 0.1),
        note(62, 1.75, 0.1),
        note(64, 2, 0.1),
        note(65, 2.25, 0.1),
    ]
    output = play(ending, notes)
    assert ending.reason == "best_boundary"
    assert output[-1].pitch == 60
    assert all(n.start < 2.25 for n in output)


def test_minor_resolution_and_rolled_chord_stay_together():
    ending = PhraseEnding(2, tonic=9, pitch_classes=(9, 11, 0, 2, 4, 5, 7))
    chord = [note(45, 2, 1), note(60, 2.02, 1), note(64, 2.03, 1)]
    output = play(ending, [note(71, 0), note(67, 1.5, 0.2)] + chord + [note(71, 3.5)])
    assert output[-3:] == chord


def test_beat_estimate_ignores_simultaneous_chord_notes():
    notes = [note(p, i * 0.5) for i in range(8) for p in (48, 60, 64, 67)]
    assert estimate_beat(notes) == 0.5
    assert estimate_beat([note(60, 0)]) == 0.5


if __name__ == "__main__":
    main()
