import pytest

from piano_duet.key_tracking import KEYS, KeyTracker, MusicalKey
from piano_duet.notes import Note


def main():
    raise SystemExit(pytest.main([__file__]))


def phrase(tonic=0, mode="major"):
    intervals = [0, 4, 7, 5, 9, 11, 2, 0, 0] if mode == "major" else [0, 3, 7, 5, 8, 10, 2, 0, 0]
    return [
        Note(pitch=60 + tonic + step, start=i * 0.4, duration=0.35, velocity=80)
        for i, step in enumerate(intervals)
    ]


@pytest.mark.parametrize("key", KEYS)
def test_recognizes_major_and_minor_in_every_transposition(key):
    result = KeyTracker().observe(phrase(key.tonic, key.mode))
    assert result["tonic"] == key.tonic
    assert result["mode"] == key.mode
    assert len(set(result["pitch_classes"])) == 7


def test_passing_note_does_not_dominate_the_rest_of_the_current_phrase():
    tracker = KeyTracker()
    tracker.observe(phrase())
    passing = phrase() + [Note(pitch=66, start=1.5, duration=0.06, velocity=50)]
    assert tracker.observe(passing)["name"] == "C major"


@pytest.mark.parametrize("tonic,mode", [(7, "major"), (2, "major"), (6, "major"), (9, "minor")])
def test_latest_phrase_changes_key_immediately_regardless_of_history(tonic, mode):
    tracker = KeyTracker()
    for _ in range(3):
        tracker.observe(phrase())
    first = tracker.observe(phrase(tonic, mode))
    assert first["name"] == MusicalKey(tonic, mode).name
    assert first["previous"] == "C major"
    assert first["changed"]
    assert set(first["pitch_classes"]) == set(MusicalKey(tonic, mode).pitch_classes)
    fresh = KeyTracker().observe(phrase(tonic, mode))
    assert first["name"] == fresh["name"]
    assert first["tentative"] == fresh["tentative"]


def test_even_a_sparse_latest_phrase_replaces_old_key_evidence():
    tracker = KeyTracker()
    tracker.observe(phrase())
    notes = [Note(pitch=66, start=0, duration=0.2, velocity=80)]
    result = tracker.observe(notes)
    assert result["name"] == KeyTracker().observe(notes)["name"]
    assert result["tentative"]


def test_sparse_first_phrase_is_explicitly_tentative():
    result = KeyTracker().observe([Note(pitch=60, start=0, duration=1, velocity=80)])
    assert result["tentative"]
    assert 0 in result["pitch_classes"]


def test_a_new_three_note_chord_sets_the_key_immediately():
    tracker = KeyTracker()
    tracker.observe([Note(pitch=p, start=0, duration=1, velocity=80) for p in (60, 64, 67)])
    result = tracker.observe(
        [Note(pitch=p, start=0, duration=1, velocity=80) for p in (66, 70, 73)]
    )
    assert result["name"] == "G♭ major"


def test_scale_spelling_matches_key_signatures_including_enharmonic_octaves():
    assert MusicalKey(6, "major").to_dict()["scale_names"] == [
        "Gb",
        "Ab",
        "Bb",
        "Cb",
        "Db",
        "Eb",
        "F",
    ]
    assert MusicalKey(8, "minor").to_dict()["signature"] == "G#m"
    for key in KEYS:
        assert len({name[0] for name in key.to_dict()["scale_names"]}) == 7


def test_empty_observation_is_an_error():
    with pytest.raises(ValueError) as error:
        KeyTracker().observe([])
    assert "at least one played note" in str(error.value)


if __name__ == "__main__":
    main()
