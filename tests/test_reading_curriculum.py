import random
from copy import deepcopy
from itertools import pairwise
from uuid import uuid4

import pytest
from fake_phrase import WeightedPhrase

from piano_duet.practice import fingerprint, next_task
from piano_duet.profile import LearnerStore
from piano_duet.reading import assess_reading, matches_reading
from piano_duet.reading_curriculum import (
    VOCABULARIES,
    WHITE_KEYS,
    reading_candidate,
    reading_progress,
)


def main():
    raise SystemExit(pytest.main([__file__]))


def independent_task(store, rng):
    for _ in range(20):
        task = next_task(store, "reading", rng, step_by_step=True, reading_phrase=WeightedPhrase)
        if not task["context"]["introduction"]:
            return task
        record(store, task)
    raise AssertionError("Introductions must lead to an independent exercise")


def record(store, task, missed=(), extra_octaves=False, hints=0):
    groups = []
    for i, note in enumerate(task["target"]):
        if i in missed:
            groups.append(
                [{"pitch": note["pitch"] + 1, "start": i + 0.1, "velocity": 80, "confidence": 0.9}]
            )
        group = [{"pitch": note["pitch"], "start": i + 0.4, "velocity": 80, "confidence": 0.9}]
        if extra_octaves:
            group.append({**group[0], "pitch": note["pitch"] + 12})
        groups.append(group)
    context = {
        **task["context"],
        "source": "microphone",
        "family": "reading",
        "hints": hints,
        "reading_timing": {"interruptions": []},
    }
    assessment, notes = assess_reading(task, groups, context)
    id_ = str(uuid4())
    store.record(
        id_,
        {"mode": "practice", "prompt": task, "context": context, "notes": notes},
        assessment,
        task["id"],
    )
    return id_, assessment


def test_reading_saves_octave_detections_without_penalizing_them(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = independent_task(store, random.Random(4))
    _, assessment = record(store, task, extra_octaves=True)
    assert assessment["score"]["score"] == 100
    assert assessment["score"]["corrections"] == 0
    assert len(store.attempts()[-1]["notes"]) == len(task["target"]) * 2
    assert not matches_reading([60], 48)
    assert not matches_reading([48, 60, 64], 48)
    assert matches_reading([36, 48, 60], 48)


def test_preview_plans_past_an_introduction_without_awarding_unplayed_evidence(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    rng = random.Random(3)
    current = next_task(store, "reading", rng, step_by_step=True, reading_phrase=WeightedPhrase)
    preview = next_task(store, "reading", rng, step_by_step=True, after_id=current["id"], reading_phrase=WeightedPhrase)
    assert current["reading"]["introduce"] == 60
    assert preview["reading"]["introduce"] == 62
    assert store.profile()["reading"]["hands"]["treble"]["introduced"] == []
    assert store.profile()["attempts"] == 0
    frozen = deepcopy(preview)
    record(store, current)
    following = next_task(store, "reading", rng, step_by_step=True, after_id=preview["id"], reading_phrase=WeightedPhrase)
    assert following["reading"]["introduce"] == 64
    assert store.task(preview["id"]) == {**frozen, "completed": False}
    record(store, preview)
    assert store.profile()["reading"]["rounds"] == 0
    assert store.profile()["reading"]["hands"]["treble"]["introduced"] == [60, 62]


def test_starting_mistakes_are_separate_from_continuation_and_help_is_not_credit(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = independent_task(store, random.Random(4))
    id_, assessment = record(store, task, missed=(0,))
    progress = store.profile()["reading"]
    assert progress["hands"]["treble"]["starts"]["accuracy"] == 0
    assert progress["hands"]["treble"]["patterns"]["accuracy"] == 100
    assert progress["hands"]["bass"]["starts"]["accuracy"] is None
    assert not progress["hands"]["treble"]["patterns"]["ready"]
    facets = {item["facet"]: item["value"] for item in assessment["evidence"]}
    assert facets["position:starts"] == 0
    assert facets["position:patterns"] == 1
    hinted = next_task(store, "reading", random.Random(5), step_by_step=True, reading_phrase=WeightedPhrase)
    record(store, hinted, hints=1)
    assert store.profile()["reading"]["rounds"] == 1
    attempts = store.attempts()
    graded = next(attempt for attempt in attempts if attempt["id"] == id_)
    graded["excluded"] = True
    assert reading_progress(attempts)["rounds"] == 0
    graded["excluded"] = False
    graded["assessment"]["evidence"] = []
    assert reading_progress(attempts)["notes"] == 0


def test_shifts_reanchor_without_changing_the_key_or_crediting_fingering(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = independent_task(store, random.Random(8))
    assert task["key"]["name"] == "C major"
    segments = task["reading"]["segments"]
    # Every score shifts at least once, always at a bar line; fingers mark only the landings.
    assert segments[0] == 0 and 2 <= len(segments) <= 4 and all(index % 4 == 0 for index in segments)
    assert [i for i, note in enumerate(task["target"]) if "finger" in note] == segments
    lows = [position["low"] for position in task["reading"]["positions"]]
    assert all(left != right for left, right in pairwise(lows))
    _, assessment = record(store, task, missed=tuple(segments[1:]))
    facets = {item["facet"]: item["value"] for item in assessment["evidence"]}
    assert facets["position:starts"] == 1
    assert facets["position:patterns"] == 1
    assert facets["position:shifts"] == 0
    assert {item["skill"] for item in assessment["evidence"]} == {"reading.pitch"}


def test_fresh_contexts_expand_vocabulary_and_introduce_real_position_changes(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    shifts = set()
    vocabularies = {}
    introductions = 0
    for seed in range(120):
        task = next_task(store, "reading", random.Random(seed), step_by_step=True, reading_phrase=WeightedPhrase)
        reading = task["reading"]
        if reading["stage_number"] >= 3:
            break
        introductions += task["context"]["introduction"]
        vocabularies[reading["clef"]] = reading["vocabulary"]
        assert all(note["duration"] == 1 for note in task["target"])
        assert reading["bars_per_row"] == 2
        assert len(reading["positions"]) == 4 if task["context"]["introduction"] else 2 <= len(reading["positions"]) <= 4
        assert [note["start"] for note in task["target"]] == (
            [0, 4, 8, 12] if task["context"]["introduction"] else list(range(16))
        )
        for segment, position in enumerate(reading["positions"]):
            start = position["index"]
            end = (
                reading["segments"][segment + 1]
                if segment + 1 < len(reading["segments"])
                else len(task["target"])
            )
            segment_notes = task["target"][start:end]
            assert all(
                position["low"] <= WHITE_KEYS.index(note["pitch"]) <= position["low"] + 4
                for note in segment_notes
            )
            offset = WHITE_KEYS.index(segment_notes[0]["pitch"]) - position["low"]
            assert segment_notes[0]["finger"] == (
                5 - offset if reading["hand"] == "left" else offset + 1
            )
            if segment:
                shifts.add(reading["clef"])
                assert position["low"] != reading["positions"][segment - 1]["low"]
                assert segment_notes[0]["start"] % 4 == 0
        record(store, task)
    assert shifts == {"treble", "bass"}
    assert all(len(notes) > 5 for notes in vocabularies.values())
    progress = store.profile()["reading"]
    assert progress["curriculum"]["number"] == 3
    assert progress["rounds"] == seed - introductions
    assert progress["introductions"] == introductions
    assert progress["change"] == 0
    assert len(progress["history"]) == 12
    assert all(
        hand["starts"]["ready"] and hand["patterns"]["ready"] for hand in progress["hands"].values()
    )


def test_repeating_one_starting_pitch_does_not_establish_transfer(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = independent_task(store, random.Random(4))
    record(store, task)
    attempt = store.attempts()[-1]
    copies = []
    for i in range(10):
        copy = deepcopy(attempt)
        copy["id"] = str(i)
        copies.append(copy)
    assert reading_progress(copies)["hands"]["treble"]["starts"]["accuracy"] == 100
    assert not reading_progress(copies)["hands"]["treble"]["starts"]["ready"]


def test_new_notes_are_introduced_without_inflating_reading_ratings(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    task = next_task(store, "reading", random.Random(2), step_by_step=True, reading_phrase=WeightedPhrase)
    assert task["reading"]["introduce"] == 60
    assert task["title"] == "Meet C4"
    assert "middle C" in task["instruction"]
    _, assessment = record(store, task)
    assert not assessment["evidence"]
    progress = store.profile()["reading"]
    assert progress["accuracy"] is None and progress["rounds"] == 0
    assert progress["introductions"] == 1
    following = next_task(store, "reading", random.Random(2), step_by_step=True, reading_phrase=WeightedPhrase)
    assert following["reading"]["introduce"] == 62


@pytest.mark.parametrize("clef", ["treble", "bass"])
@pytest.mark.parametrize("advanced", [False, True])
def test_melodies_keep_the_targeted_anchors_intervals_and_playable_positions(clef, advanced):
    progress = reading_progress([])
    progress["hands"]["bass" if clef == "treble" else "treble"]["samples"] = 1000
    hand = progress["hands"][clef]
    if advanced:
        progress["curriculum"].update(current="steps_skips", number=2, target="steps_skips", target_number=2)
        hand["vocabulary"] = VOCABULARIES[clef]
        hand["patterns"].update(accuracy=100, samples=20)
    melodies = set()
    for seed in range(30):
        task = reading_candidate(progress, random.Random(seed), WeightedPhrase)
        notes = task["target"]
        melodies.add(fingerprint(notes))
        assert task["reading"]["composition"] == {"method": "aria"}
        assert [note["start"] for note in notes] == list(range(16))
        assert all(note["duration"] == 1 for note in notes)
        for position in task["reading"]["positions"]:
            index = position["index"]
            pitches = [note["pitch"] for note in notes[index : index + 4]]
            assert all(
                pitch in hand["vocabulary"]
                and position["low"] <= WHITE_KEYS.index(pitch) <= position["low"] + 4
                for pitch in pitches
            )
            assert all(
                abs(WHITE_KEYS.index(b) - WHITE_KEYS.index(a)) <= (2 if advanced else 1)
                for a, b in pairwise(pitches)
            )
        assert all(len({n["pitch"] for n in notes[i : i + 3]}) > 1 for i in range(14))
    assert len(melodies) > 20


def test_aria_keeps_reading_fresh_across_restarts(tmp_path):
    path = tmp_path / "learner.sqlite3"
    seen = set()
    for _ in range(25):
        task = next_task(LearnerStore(path), "reading", random.Random(4), reading_phrase=WeightedPhrase)
        if task["reading"]["introduce"] is None:
            assert task["reading"]["composition"] == {"method": "aria"}
        else:
            assert "composition" not in task["reading"]
        assert fingerprint(task["target"]) not in seen
        seen.add(fingerprint(task["target"]))


def test_weak_intervals_weight_the_notes_aria_may_choose():
    progress = reading_progress([])
    progress["curriculum"].update(current="steps_skips", number=2, target="steps_skips", target_number=2)
    progress["hands"]["bass"]["samples"] = 1000
    hand = progress["hands"]["treble"]
    hand["vocabulary"] = VOCABULARIES["treble"]
    for stats in hand["pitches"].values():
        stats.update(accuracy=100, samples=100)
    hand["movements"] = {str(interval): {"accuracy": 100} for interval in range(-12, 13)}

    def preference():
        """How much more weight a step down gets than a step up whenever Aria may choose either."""
        ratios = []

        class Recording(WeightedPhrase):
            def note(self, onset, pitches, durations):
                if self.notes:
                    previous = self.notes[-1][1]
                    down = [w for p, w in pitches.items() if p - previous == -2]
                    up = [w for p, w in pitches.items() if p - previous == 2]
                    ratios.extend(d / u for d in down for u in up)
                return super().note(onset, pitches, durations)

        for seed in range(30):
            reading_candidate(progress, random.Random(seed), Recording)
        assert ratios
        return ratios

    assert set(preference()) == {1}
    hand["movements"]["-2"]["accuracy"] = 0
    assert set(preference()) == {6}


def test_aria_continues_the_score_shown_just_before(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    written = []

    def phrase(rng, context=None):
        written.append(WeightedPhrase(rng, context))
        return written[-1]

    # Past the note introductions, which show single notes without Aria.
    independent_task(store, random.Random(3))
    first = next_task(store, "reading", random.Random(3), step_by_step=True, reading_phrase=phrase)
    assert written[-1].context is None
    following = next_task(store, "reading", random.Random(3), step_by_step=True, after_id=first["id"], reading_phrase=phrase)
    assert written[-1].context == {"notes": first["target"], "end": 16}
    assert following["target"][0]["start"] == 0


def test_single_note_introductions_do_not_use_aria(tmp_path):
    def unexpected(rng):
        raise AssertionError("A note introduction is not a melody")

    task = next_task(
        LearnerStore(tmp_path / "learner.sqlite3"),
        "reading",
        random.Random(2),
        step_by_step=True,
        reading_phrase=unexpected,
    )
    assert task["reading"]["introduce"] == 60
    assert len(task["target"]) == 4


def test_reading_without_aria_fails_without_issuing_a_score(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    with pytest.raises(ValueError, match="needs Aria"):
        next_task(store, "reading", random.Random(4))
    assert not store.reading_fingerprints()


if __name__ == "__main__":
    main()
