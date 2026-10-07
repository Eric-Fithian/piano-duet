import random
from collections import Counter
from copy import deepcopy
from uuid import uuid4

import pytest

from piano_duet.assessment import assess
from piano_duet.notes import Note
from piano_duet.practice import fingerprint, next_task, select_key
from piano_duet.profile import LearnerStore


def main():
    raise SystemExit(pytest.main([__file__]))


def complete(store, task, pitches=None):
    notes = [Note.model_validate(note) for note in task["target"]]
    if pitches:
        notes = [
            note.model_copy(update={"pitch": pitch})
            for note, pitch in zip(notes, pitches, strict=True)
        ]
    context = {**task["context"], "source": "microphone", "family": task["family"]}
    assessment = assess(task, notes, context, {"usable": True, "reason": "Test input"})
    store.record(
        str(uuid4()),
        {
            "mode": "practice",
            "prompt": task,
            "notes": [n.model_dump() for n in notes],
            "context": context,
        },
        assessment,
        task["id"],
    )


def test_reading_is_unseen_across_restarts_and_changes_after_assessment(tmp_path):
    path = tmp_path / "learner.sqlite3"
    store = LearnerStore(path)
    first = next_task(store, "reading", random.Random(1))
    second = next_task(LearnerStore(path), "reading", random.Random(1))
    assert fingerprint(first["target"]) != fingerprint(second["target"])
    complete(store, first)
    third = next_task(store, "reading", random.Random(1))
    assert all(n["pitch"] < 60 for n in third["target"])
    assert "bass" in third["reason"]


def test_weak_and_untested_keys_are_distinct_and_zero_accuracy_is_not_ignored():
    key, reason = select_key({"conditions": [{"id": "key:G", "accuracy": 0, "attempts": 1}]})
    assert key["name"] == "G major" and "less accurate" in reason
    key, reason = select_key({"conditions": [{"id": "key:C", "accuracy": 100, "attempts": 1}]})
    assert key["name"] == "G major" and "less practice" in reason


def test_guided_practice_explores_after_success_and_repairs_after_difficulty(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    first = next_task(store)
    assert first["family"] == "technique"
    complete(store, first)
    next_ = next_task(store)
    assert next_["family"] == "reading"
    complete(store, next_, [n["pitch"] + 24 for n in next_["target"]])
    repair = next_task(store)
    assert repair["family"] == "reading" and repair["purpose"] == "Repair"
    assert all(note["pitch"] >= 60 for note in repair["target"])
    assert fingerprint(repair["target"]) != fingerprint(next_["target"])


def test_every_generated_task_has_valid_piano_notes_and_independent_context(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    for focus in ("technique", "reading", "theory", "ear", "repertoire"):
        task = next_task(store, focus)
        assert all(Note.model_validate(note) for note in task["target"])
        assert not task["context"]["hearings"] and not task["context"]["reveals"]
        assert store.task(task["id"])["target"] == task["target"]
        before = deepcopy(task)
        store.aid(task["id"], "hearings")
        assert store.task(task["id"])["context"]["hearings"] == 1
        assert task == before


def test_completed_task_cannot_be_submitted_twice_or_receive_new_hints(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = next_task(store, "reading")
    complete(store, task)
    with pytest.raises(ValueError, match="already been completed"):
        complete(store, task)
    with pytest.raises(ValueError, match="unfinished"):
        store.aid(task["id"], "reveals")
    assert store.profile()["attempts"] == 1


def test_fresh_reading_keeps_variety_while_targeting_a_missed_pitch(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = next_task(store, "reading", random.Random(5))
    pitches = [n["pitch"] + (1 if n["pitch"] == 67 else 0) for n in task["target"]]
    complete(store, task, pitches)
    for seed in range(15):
        fresh = next_task(store, "reading", random.Random(seed))
        notes = [n["pitch"] for n in fresh["target"]]
        assert len(set(notes)) >= 4
        assert max(Counter(notes).values()) <= 2
        if 67 in [n["pitch"] for n in task["target"]]:
            assert 67 in notes


def test_a_named_chord_failure_gets_a_shown_execution_check_before_diagnosis(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = next_task(store, "theory")
    assert task["shape"] == "chord"
    complete(store, task, [n["pitch"] + 1 for n in task["target"]])
    check = next_task(store)
    assert check["family"] == "technique" and check["purpose"] == "Check"
    assert check["context"]["notation_visible"]
    assert {n["pitch"] for n in check["target"]} == {n["pitch"] for n in task["target"]}
    assert check["cue"] == "C4 + E4 + G4"


def test_repertoire_chord_evidence_can_choose_an_isolated_technique_task(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = next_task(store, "repertoire")
    task["target"] = [
        {"pitch": pitch, "start": 0, "duration": 1, "velocity": 76} for pitch in (60, 64, 67)
    ]
    complete(store, task, [60, 65, 67])
    isolated = next_task(store)
    assert isolated["family"] == "technique"
    assert isolated["shape"] == "chord"
    assert isolated["purpose"] == "Repair"
    assert len(isolated["target"]) == 12
    assert {n["pitch"] for n in isolated["target"]} == {60, 64, 67}


if __name__ == "__main__":
    main()
