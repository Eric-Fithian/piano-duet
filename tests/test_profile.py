from copy import deepcopy
from uuid import uuid4

import pytest

from piano_duet.assessment import assess, pitch_name
from piano_duet.key_tracking import MusicalKey
from piano_duet.notes import Note
from piano_duet.practice import next_task, sequence
from piano_duet.profile import LearnerStore

QUALITY = {"usable": True, "onset_support": 0.95, "reason": "Test input"}
CONTEXT = {
    "source": "microphone",
    "notation_visible": False,
    "hearings": 0,
    "reveals": 0,
    "hints": 0,
    "familiar": False,
    "family": "theory",
}


def main():
    raise SystemExit(pytest.main([__file__]))


def scale_prompt(family="theory", challenge=1):
    return {
        "title": "C major scale",
        "family": family,
        "shape": "scale",
        "challenge": challenge,
        "target": sequence([60, 62, 64, 65, 67, 69, 71, 72], 60),
        "bpm": 60,
        "key": MusicalKey(0, "major").to_dict(),
        "even": True,
        "dynamics": "even",
    }


def record(store, prompt, notes=None, context=None, quality=None):
    context = {**CONTEXT, "family": prompt["family"], **(context or {})}
    notes = notes if notes is not None else [Note.model_validate(n) for n in prompt["target"]]
    assessment = assess(prompt, notes, context, quality or QUALITY)
    id_ = str(uuid4())
    store.record(
        id_,
        {
            "prompt": prompt,
            "notes": [n.model_dump() for n in notes],
            "context": context,
            "mode": "practice",
        },
        assessment,
    )
    return id_, assessment


def skill(store, id_):
    return next(row for row in store.profile()["skills"] if row["id"] == id_)


def test_named_scale_informs_theory_and_execution_without_duplicate_evidence(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    _, assessment = record(store, scale_prompt())
    names = {row["skill"] for row in assessment["evidence"]}
    assert {"theory.scales", "technique.scales", "technique.accuracy"} <= names
    assert "reading.pitch" not in names
    assert len({(row["skill"], row["facet"]) for row in assessment["evidence"]}) == len(
        assessment["evidence"]
    )
    assert skill(store, "theory.scales")["conditions"][0]["label"] == "C major"


def test_levels_require_demonstrated_challenges_not_accumulated_repetition(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    assert skill(store, "theory.scales")["level"] is None
    record(store, scale_prompt())
    assert skill(store, "theory.scales")["level"] == 0
    for _ in range(8):
        record(store, scale_prompt())
    assert skill(store, "theory.scales")["level"] == 1
    for _ in range(3):
        record(store, scale_prompt(challenge=2))
    assert skill(store, "theory.scales")["level"] == 2


def test_failed_named_recall_does_not_invent_technique_weakness(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    prompt = scale_prompt()
    notes = [Note.model_validate({**n, "pitch": n["pitch"] + 24}) for n in prompt["target"]]
    _, assessment = record(store, prompt, notes)
    assert skill(store, "theory.scales")["accuracy"] == 0
    assert skill(store, "technique.accuracy")["level"] is None
    assert skill(store, "technique.scales")["level"] is None
    assert assessment["observations"][0]["expected"] == 60
    assert assessment["observations"][0]["heard"] == [84]


def test_assisted_theory_gives_execution_but_not_recall_credit(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    record(store, scale_prompt(), context={"reveals": 1})
    assert skill(store, "technique.scales")["accuracy"] == 100
    assert skill(store, "theory.scales")["level"] is None


def test_theory_timing_is_optional_and_reference_help_is_recorded(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    prompt = scale_prompt()
    notes = [
        Note.model_validate({**n, "start": i * i * 0.2}) for i, n in enumerate(prompt["target"])
    ]
    _, assessment = record(store, prompt, notes, {"hints": 1})
    assert assessment["score"]["score"] == 100
    assert assessment["score"]["rhythm_accuracy"] is None
    assert skill(store, "theory.scales")["level"] is None


def test_reading_failure_is_not_automatically_a_technique_failure(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    prompt = scale_prompt("reading")
    notes = [Note.model_validate({**n, "pitch": n["pitch"] + 24}) for n in prompt["target"]]
    record(store, prompt, notes, {"notation_visible": True})
    assert skill(store, "reading.pitch")["accuracy"] == 0
    assert skill(store, "technique.accuracy")["accuracy"] is None


def test_repertoire_exposes_specific_chord_difficulty_without_inventing_theory_error(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    prompt = scale_prompt("repertoire")
    prompt["shape"] = "melody"
    prompt["piece_id"] = "piece"
    prompt["target"] = [
        {"pitch": pitch, "start": 0, "duration": 1, "velocity": 76} for pitch in (60, 64, 67)
    ]
    notes = [
        Note.model_validate({**n, "pitch": 65 if n["pitch"] == 64 else n["pitch"]})
        for n in prompt["target"]
    ]
    record(store, prompt, notes, {"notation_visible": True, "familiar": True})
    chords = skill(store, "technique.chords")
    assert chords["accuracy"] == 67
    assert any(c["label"] == "C4 + E4 + G4" for c in chords["conditions"])
    assert skill(store, "theory.chords")["level"] is None


def test_reading_tracks_expected_notes_and_does_not_count_heard_examples(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    prompt = scale_prompt("reading")
    notes = [Note.model_validate(n) for n in prompt["target"]]
    notes[1] = notes[1].model_copy(update={"pitch": 61})
    record(store, prompt, notes, {"notation_visible": True})
    conditions = {c["id"]: c for c in skill(store, "reading.pitch")["conditions"]}
    assert conditions["pitch:62"]["accuracy"] == 0
    assert conditions["pitch:60"]["accuracy"] == 100
    record(store, prompt, context={"notation_visible": True, "hearings": 1})
    assert skill(store, "reading.pitch")["attempts"] == 1


def test_demos_uncertain_audio_and_empty_attempts_never_change_levels(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    record(store, scale_prompt(), context={"source": "demo"})
    record(store, scale_prompt(), quality={"usable": False, "reason": "Weak attacks"})
    record(store, scale_prompt(), notes=[])
    assert all(s["level"] is None for s in store.profile()["skills"])
    assert store.profile()["attempts"] == 2


def test_free_play_is_saved_without_inferring_mistakes_or_theory(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    prompt = {"title": "An idea", "target": [], "family": "creating", "challenge": 1}
    record(store, prompt, [Note(pitch=61, start=0, duration=0.5, velocity=60)])
    assert store.profile()["notes"] == 1
    assert all(s["level"] is None for s in store.profile()["skills"])


def test_slow_control_preserves_rhythm_but_not_full_speed_credit(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    prompt = scale_prompt("technique")
    notes = [Note.model_validate({**n, "start": n["start"] * 2}) for n in prompt["target"]]
    record(store, prompt, notes, {"notation_visible": True})
    assert skill(store, "technique.evenness")["accuracy"] == 100
    assert skill(store, "technique.tempo")["accuracy"] == 50


def test_history_survives_restart_and_exclusion_rebuilds_all_shared_skills(tmp_path):
    path = tmp_path / "learner.sqlite3"
    store = LearnerStore(path)
    prompt = scale_prompt()
    id_, _ = record(store, prompt)
    original = deepcopy(store.attempts()[0])
    restarted = LearnerStore(path)
    assert restarted.attempts()[0] == original
    restarted.exclude(id_, True)
    assert all(s["level"] is None for s in restarted.profile()["skills"])
    assert restarted.attempts()[0]["notes"] == original["notes"]
    assert restarted.attempts()[0]["prompt"] == prompt
    restarted.exclude(id_, False)
    assert skill(restarted, "theory.scales")["accuracy"] == 100


def test_duplicate_attempt_id_cannot_inflate_profile(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    id_, assessment = record(store, scale_prompt())
    with pytest.raises(ValueError, match="already been saved"):
        store.record(id_, store.attempts()[0], assessment)
    assert store.profile()["attempts"] == 1


def test_repertoire_memory_requires_familiar_unaided_material(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = next_task(store, "repertoire")
    record(store, task, context=task["context"])
    assert skill(store, "repertoire.recall")["level"] is None
    second = next_task(store, "repertoire")
    assert second["context"]["familiar"]
    assert not second["context"]["notation_visible"]
    record(store, second, context=second["context"])
    assert skill(store, "repertoire.recall")["accuracy"] == 100


def test_expected_note_labels_follow_the_task_key_across_octave_boundaries():
    assert pitch_name(71, MusicalKey(6, "major").to_dict()) == "C♭5"
    assert pitch_name(68, MusicalKey(8, "minor").to_dict()) == "G♯4"


if __name__ == "__main__":
    main()
