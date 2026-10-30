from copy import deepcopy
from itertools import pairwise
from random import Random

import pytest
from fake_phrase import WeightedPhrase

from piano_duet.key_tracking import MusicalKey
from piano_duet.practice import next_task
from piano_duet.profile import LearnerStore
from piano_duet.reading import assess_reading, matches_reading
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import choose_context, compose_reading, reading_attacks
from piano_duet.reading_stages import (
    STAGES,
    curriculum_progress,
    reading_rhythm,
    stage_by_id,
    stage_requirements,
)


def main():
    raise SystemExit(pytest.main([__file__]))


def performance(task, id_, *, pace=1, missed=(), hints=0):
    groups = []
    for index, attack in enumerate(reading_attacks(task["target"])):
        if index in missed:
            groups.append(
                [
                    {
                        "pitch": 108,
                        "start": 1 + attack["start"] * pace - 0.02,
                        "velocity": 80,
                        "confidence": 0.95,
                    }
                ]
            )
        groups.append(
            [
                {
                    "pitch": task["target"][i]["pitch"],
                    "start": 1 + attack["start"] * pace,
                    "velocity": 80,
                    "confidence": 0.95,
                }
                for i in attack["indices"]
            ]
        )
    context = {
        **task.get("context", {}),
        "source": "microphone",
        "hearings": 0,
        "reveals": 0,
        "hints": hints,
        "reading_timing": {"interruptions": []},
    }
    assessment, notes = assess_reading(task, groups, context)
    return {
        "id": id_,
        "created_at": id_,
        "excluded": False,
        "prompt": deepcopy(task),
        "context": context,
        "assessment": assessment,
        "notes": notes,
    }


def compose(stage, seed=0):
    profile = reading_progress([])
    profile["curriculum"].update(current=stage["id"], number=stage["number"], target=stage["id"], target_number=stage["number"], contexts=[])
    task = compose_reading(profile, Random(seed), WeightedPhrase)
    return {**task, "family": "reading", "id": f"{stage['id']}-{seed}"}


@pytest.mark.parametrize("stage", STAGES[2:], ids=lambda stage: stage["id"])
def test_every_stage_has_playable_scores_and_preserves_its_targets(stage):
    for seed in range(12):
        task = compose(stage, seed)
        end = (
            stage["bars"]
            * int(task["meter"].split("/")[0])
            * 4
            / int(task["meter"].split("/")[1])
            * 60
            / task["bpm"]
        )
        for variant in [task["target"]]:
            assert variant == sorted(variant, key=lambda note: (note["start"], note["pitch"]))
            assert all(
                21 <= note["pitch"] <= 108
                and note["duration"] > 0
                and note["start"] + note["duration"] <= end + 1e-5
                for note in variant
            )
            if not stage["rest_probability"]:
                sounding_until = 0
                for note in variant:
                    assert note["start"] <= sounding_until + 1e-5
                    sounding_until = max(sounding_until, note["start"] + note["duration"])
                assert sounding_until == pytest.approx(end)
            for attack in reading_attacks(variant):
                pitches = [variant[i]["pitch"] for i in attack["indices"]]
                assert len(set(pitches)) == len(pitches)
                for staff in ("treble", "bass"):
                    chord = [
                        variant[i]["pitch"]
                        for i in attack["indices"]
                        if variant[i]["staff"] == staff
                    ]
                    assert not chord or max(chord) - min(chord) <= 12
        assessment = performance(task, seed)["assessment"]
        assert assessment["score"]["pitch_accuracy"] == 100
        if stage["rhythm_required"]:
            assert assessment["rhythm"]["accuracy"] == 100
            assert assessment["rhythm"]["bpm"] == task["bpm"]
        cues = task["reading"]["positions"]
        for staff in ("treble", "bass"):
            positions = [cue for cue in cues if cue["clef"] == staff]
            assert all(left["low"] != right["low"] for left, right in pairwise(positions))


class LoopingPhrase(WeightedPhrase):
    """An Aria that always wants to repeat itself: the constraints alone must keep the melody moving."""

    def note(self, onset, pitches, durations):
        history = [pitch for _, pitch, _ in self.notes]
        favourite = next((p for p in (history[-2:-1] + history[-1:]) if p in pitches), None)
        if favourite is None:
            return super().note(onset, pitches, durations)
        self.notes.append((onset, favourite, min(durations)))
        return favourite, min(durations)


@pytest.mark.parametrize("stage", STAGES[2:], ids=lambda stage: stage["id"])
def test_constraints_stop_a_repetitive_model_from_droning(stage):
    profile = reading_progress([])
    profile["curriculum"].update(current=stage["id"], number=stage["number"], target=stage["id"], target_number=stage["number"], contexts=[])
    for seed in range(5):
        task = compose_reading(profile, Random(seed), LoopingPhrase)
        for staff in ("treble", "bass"):
            attacks = [
                min(task["target"][i]["pitch"] for i in attack["indices"] if task["target"][i]["staff"] == staff)
                for attack in reading_attacks(task["target"])
                if any(task["target"][i]["staff"] == staff for i in attack["indices"])
            ]
            for i in range(len(attacks)):
                assert attacks[i - 2 : i + 1] != [attacks[i]] * 3 or i < 2
                window = attacks[i - 4 : i + 1] if i >= 4 else []
                assert not (window and window[0] == window[2] == window[4] != window[1] == window[3])


def bars_of(task):
    """Each bar's notes, by written time."""
    beats = int(task["meter"].split("/")[0]) * 4 / int(task["meter"].split("/")[1])
    unit = 60 / task["bpm"]
    bars = [[] for _ in range(task["reading"]["bars"])]
    for note in task["target"]:
        bars[int(round(note["start"] / unit, 4) // beats)].append(note)
    return bars


def test_new_features_are_present_in_their_introductory_stage():
    white = [p for p in range(21, 109) if p % 12 in (0, 2, 4, 5, 7, 9, 11)]
    placements = set()
    for index, step in [(2, 3), (3, 4)] * 15:
        task = compose(STAGES[index], len(placements) * 7 + index)
        for bar in bars_of(task):
            moves = [abs(white.index(a["pitch"]) - white.index(b["pitch"])) for a, b in pairwise(bar)]
            # The stage's interval is in every bar, anywhere in it, and nothing larger.
            assert step in moves and max(moves) <= step
            placements.add(moves.index(step))
        for cue in task["reading"]["positions"]:
            first = task["target"][cue["index"]]
            offset = white.index(first["pitch"]) - cue["low"]
            assert first["finger"] == (offset + 1 if cue["clef"] == "treble" else 5 - offset)
    assert placements >= {0, 1, 2}
    durations = set()
    for seed in range(30):
        task = compose(STAGES[4], seed)
        values = {n["duration"] for n in task["target"]}
        assert len(values) >= 2
        durations.update(values)
    assert durations == {1, 2, 4}
    for seed in range(10):
        task = compose(stage_by_id("pairs"), seed)
        for bar in bars_of(task):
            starts = [note["start"] for note in bar]
            chords = [start for start in set(starts) if starts.count(start) == 2]
            # Two-note shapes start only on beats, and every bar has at least one.
            assert chords and all(abs(start * task["bpm"] / 60 - round(start * task["bpm"] / 60)) < 1e-6 for start in chords)
    for stage_id in ("grand_staff", "together", "independence", "expert"):
        task = compose(stage_by_id(stage_id))
        assert {n["staff"] for n in task["target"]} == {"treble", "bass"}
        assert task["reading"]["clef"] == "grand"
    sizes, octaves = set(), False
    for seed in range(20):
        task = compose(stage_by_id("voicings"), seed)
        for attack in reading_attacks(task["target"]):
            treble = [task["target"][i]["pitch"] for i in attack["indices"] if task["target"][i]["staff"] == "treble"]
            sizes.add(len(treble))
            octaves |= any(b - a == 12 for a, b in pairwise(treble))
    assert {1, 2, 3, 4} <= sizes and octaves


def test_scores_shift_hand_position_at_least_once_and_carry_a_few_figures_and_accidentals():
    for seed in range(20):
        task = compose(stage_by_id("dotted"), seed)
        shifts = [cue for cue in task["reading"]["positions"] if cue["clef"] == "treble" or task["reading"]["clef"] != "grand"]
        assert 2 <= len(shifts) <= 4
        dotted = [note for note in task["target"] if abs(note["duration"] * task["bpm"] / 60 - 1.5) < 1e-6]
        assert len({round(note["start"], 4) for note in dotted}) == 2
    counts = set()
    for seed in range(20):
        task = compose(stage_by_id("more_keys"), seed)
        chromatic = [note for note in task["target"] if note["pitch"] % 12 not in task["key"]["pitch_classes"]]
        counts.add(len({round(note["start"], 4) for note in chromatic}))
        assert all(sum(note["pitch"] % 12 not in task["key"]["pitch_classes"] for note in bar) <= 1 for bar in bars_of(task))
    assert counts == {1, 2}


def test_rests_are_optional_in_later_music_without_a_standalone_stage():
    stage_ids = [stage["id"] for stage in STAGES]
    assert "rests" not in stage_ids
    assert stage_ids[stage_ids.index("long_notes") + 1] == "eighths"
    assert all(not stage["rest_probability"] for stage in STAGES[: stage_ids.index("ties")])
    gaps = set()
    for seed in range(30):
        task = compose(stage_by_id("ties"), seed)
        sounding_until = 0
        has_rest = False
        for note in (note for note in task["target"] if note["staff"] == "treble"):
            has_rest |= note["start"] > sounding_until + 1e-5
            sounding_until = max(sounding_until, note["start"] + note["duration"])
        gaps.add(has_rest)
    assert gaps == {False, True}


def test_retired_rest_practice_keeps_note_credit_without_gating_the_curriculum():
    task = compose(stage_by_id("long_notes"))
    task["reading"].update(stage_id="rests", stage_number=6)
    attempt = performance(task, 0)
    profile = reading_progress([attempt])
    assert profile["notes"] == len(task["target"])
    assert profile["curriculum"]["completed"] == 0
    assert "rests" not in {stage["id"] for stage in profile["curriculum"]["path"]}
    assert attempt["prompt"]["reading"]["stage_id"] == "rests"


def test_a_new_learner_can_advance_through_every_stage_and_earned_stages_stay_earned(tmp_path):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    attempts = []
    rng = Random(17)
    for index in range(200):
        task = next_task(store, "reading", rng, step_by_step=True, reading_phrase=WeightedPhrase)
        if task["reading"]["stage_number"] >= 3:
            break
        attempt = performance(task, index)
        attempts.append(attempt)
        store.record(
            str(index),
            {
                "mode": "practice",
                "prompt": task,
                "context": attempt["context"],
                "notes": attempt["notes"],
            },
            attempt["assessment"],
            task["id"],
        )
    assert curriculum_progress(attempts)["number"] == 3
    old_attempts = deepcopy(attempts)
    for attempt in old_attempts:
        attempt["prompt"]["reading"].pop("stage_id")
    assert curriculum_progress(old_attempts)["number"] == 3
    profile = reading_progress(attempts)
    for stage in STAGES[2:]:
        for count in range(80):
            assert profile["curriculum"]["current"] == stage["id"]
            task = compose_reading(profile, rng, WeightedPhrase)
            task.update(id=f"stage-{stage['number']}-{count}", family="reading")
            attempts.append(performance(task, len(attempts)))
            profile["curriculum"] = curriculum_progress(attempts)
            if profile["curriculum"]["current"] != stage["id"] or profile["curriculum"]["finished"]:
                break
        else:
            pytest.fail(f"Perfect reading cannot complete {stage['id']}: {profile['curriculum']}")
        assert profile["curriculum"]["path"][stage["number"] - 1]["status"] == "Complete"
    assert profile["curriculum"]["completed"] == len(STAGES)
    for index in range(10):
        task = compose(STAGES[-1], 1000 + index)
        attempts.append(performance(task, len(attempts), missed=range(100)))
    assert curriculum_progress(attempts)["finished"]
    for attempt in attempts:
        if attempt["prompt"]["reading"]["stage_id"] == "triplets":
            attempt["excluded"] = True
    assert curriculum_progress(attempts)["current"] == "triplets"


def test_rhythm_distinguishes_spacing_from_tempo_and_ignores_breaks():
    task = compose(stage_by_id("sixteenths"))
    good = performance(task, 0)
    slow = performance(task, 1, pace=2)
    assert (
        good["assessment"]["rhythm"]["accuracy"] == slow["assessment"]["rhythm"]["accuracy"] == 100
    )
    assert slow["assessment"]["rhythm"]["bpm"] == task["bpm"] // 2
    rows = deepcopy(good["assessment"]["observations"])
    for i, row in enumerate(rows):
        row["heard_at"] = i + 1
    assert reading_rhythm(task, rows, good["context"])["accuracy"] < 80
    for row in rows:
        row["heard_at"] *= 20
    assert reading_rhythm(task, rows, good["context"])["accuracy"] is None
    assert reading_rhythm(task, rows, {})["accuracy"] is None


def test_inaccurate_assisted_slow_and_repeated_reading_cannot_unlock_stages():
    task = compose(stage_by_id("sixteenths"))
    cases = [
        [performance({**task, "id": str(i)}, i, hints=1) for i in range(20)],
        [performance({**task, "id": str(i)}, i, pace=3) for i in range(20)],
        [performance({**task, "id": str(i)}, i, missed=range(100)) for i in range(20)],
        [performance(task, i) for i in range(20)],
    ]
    for attempts in cases:
        stage = next(
            row for row in curriculum_progress(attempts)["path"] if row["id"] == "sixteenths"
        )
        assert stage["status"] != "Complete"
    assert matches_reading([48, 60, 64, 67, 76], [48, 60, 64, 67])
    assert not matches_reading([48, 60, 64], [48, 60, 64, 67])
    assert not matches_reading([48, 60, 64, 66, 67], [48, 60, 64, 67])


def test_general_reading_evidence_without_a_live_curriculum_prompt_keeps_its_other_credit():
    task = compose(STAGES[2])
    attempt = performance(task, 0)
    attempt["prompt"].pop("reading")
    assert curriculum_progress([attempt])["completed"] == 0
    assert reading_progress([attempt])["notes"] == len(task["target"])


def test_weak_reading_intervals_still_weight_what_aria_may_write():
    profile = reading_progress([])
    profile["curriculum"].update(
        current="eighths", number=stage_by_id("eighths")["number"], contexts=[]
    )
    for hand in profile["hands"].values():
        hand["movements"] = {str(i): {"accuracy": 100} for i in range(-12, 13)}

    def occurrences():
        count = 0
        for seed in range(100):
            task = compose_reading(profile, Random(seed), WeightedPhrase)
            first, second = task["target"][:2]
            count += second["pitch"] - first["pitch"] == 2
        return count

    baseline = occurrences()
    for hand in profile["hands"].values():
        hand["movements"]["2"]["accuracy"] = 0
    assert occurrences() > baseline * 1.5


def test_key_coverage_requires_successful_reading_rather_than_merely_seeing_the_key():
    records = [
        {
            "clef": "grand",
            "key": str(i),
            "meter": "4/4",
            "pitch_values": [1],
            "rhythm": {"accuracy": 100, "bpm": 72},
        }
        for i in range(24)
    ]
    records[0]["pitch_values"] = [0]
    progress = stage_requirements(stage_by_id("all_keys"), records)
    assert progress["groups"][0]["ready"]
    assert progress["keys"] == 23
    assert not progress["ready"]
    records[0]["pitch_values"] = [1]
    assert stage_requirements(stage_by_id("all_keys"), records)["ready"]


def test_new_signatures_increase_by_one_accidental_only_after_successful_reading():
    progress = reading_progress([])
    stage = stage_by_id("more_keys")
    keys = [MusicalKey(*key).to_dict() for key in stage["keys"]]
    size = {key["signature"]: sum(len(name) - 1 for name in key["scale_names"]) for key in keys}
    for established in (-1, 0, 1, 2, 3):
        progress["curriculum"]["demonstrated_keys"] = [
            key["signature"] for key in keys if size[key["signature"]] <= established
        ]
        chosen = [choose_context(stage, progress, Random(seed))[1] for seed in range(100)]
        assert max(size[key["signature"]] for key in chosen) == established + 1


def test_long_note_scores_vary_their_rhythm_without_repeating_recent_patterns():
    stage = stage_by_id("long_notes")
    profile = reading_progress([])
    profile["curriculum"].update(current=stage["id"], number=stage["number"], target=stage["id"], target_number=stage["number"], contexts=[])
    patterns = set()
    rng = Random(29)
    for _ in range(40):
        task = compose_reading(profile, rng, WeightedPhrase)
        pattern = [[n["start"], n["duration"]] for n in task["target"]]
        assert pattern not in profile["curriculum"]["recent_rhythms"]
        profile["curriculum"]["recent_rhythms"] = (
            profile["curriculum"]["recent_rhythms"] + [pattern]
        )[-4:]
        patterns.add(tuple(map(tuple, pattern)))
        assessment = performance({**task, "family": "reading", "id": "check"}, 0)["assessment"]
        assert assessment["rhythm"]["accuracy"] == 100
        assert assessment["rhythm"]["intervals"] >= 2
    assert len(patterns) >= 15


def test_early_rhythm_separates_finding_the_next_position_from_counting_note_values():
    task = compose(STAGES[4])
    task["target"] = [
        {"pitch": pitch, "start": start, "duration": duration, "velocity": 80}
        for pitch, start, duration in [(60, 0, 2), (62, 2, 1), (64, 3, 1), (65, 4, 4)]
    ]
    task["reading"]["positions"] = [{"index": 0}, {"index": 3}]
    rows = [
        {
            "index": i,
            "start": note["start"],
            "heard_at": 1 + note["start"],
            "group": i,
            "confidence": 0.95,
            "matched": True,
        }
        for i, note in enumerate(task["target"])
    ]
    rows[-1]["heard_at"] += 2
    context = {"reading_timing": {"interruptions": []}}
    rhythm = reading_rhythm(task, rows, context)
    assert rhythm["accuracy"] == 100
    assert rhythm["intervals"] == 2
    assert rhythm["coverage"] == 1
    task["reading"]["stage_id"] = "dotted"
    assert reading_rhythm(task, rows, context)["accuracy"] < 80
    task["reading"]["stage_id"] = "long_notes"
    rows[1]["matched"] = False
    assert reading_rhythm(task, rows, context)["accuracy"] is None


def test_simple_stages_finish_after_three_good_recent_scores_per_hand():
    attempts = []
    for hand in ("treble", "bass"):
        for i in range(8):
            task = compose(STAGES[4], len(attempts))
            task["reading"]["clef"] = hand
            attempts.append(performance(task, len(attempts), missed=range(100)))
    assert curriculum_progress(attempts)["path"][4]["status"] != "Complete"
    for hand in ("treble", "bass"):
        for i in range(3):
            task = compose(STAGES[4], len(attempts))
            task["reading"]["clef"] = hand
            attempts.append(performance(task, len(attempts)))
            if hand == "treble" or i < 2:
                assert curriculum_progress(attempts)["path"][4]["status"] != "Complete"
    stage = curriculum_progress(attempts)["path"][4]
    assert stage["status"] == "Complete"
    assert all(group["required"] == group["samples"] == 3 for group in stage["groups"])
    assert all(group["accuracy"] == group["rhythm"] == 100 for group in stage["groups"])


def test_a_mastered_hand_does_not_keep_getting_assigned_to_balance_attempt_counts():
    progress = reading_progress([])
    progress["curriculum"].update(
        current="long_notes",
        number=5,
        contexts=[
            {"clef": "bass", "key": "C", "meter": "4/4", "samples": 10},
        ],
    )
    for group in progress["curriculum"]["path"][4]["groups"]:
        group["ready"] = group["hand"] == "treble"
    for seed in range(10):
        assert choose_context(STAGES[4], progress, Random(seed))[0] == "bass"


def test_the_preview_varies_the_current_rhythm_before_that_score_is_saved(tmp_path, monkeypatch):
    store = LearnerStore(tmp_path / "learner.sqlite3")
    profile = store.profile()
    profile["reading"]["curriculum"].update(current="long_notes", number=5, target="long_notes", target_number=5, contexts=[])
    monkeypatch.setattr(store, "profile", lambda: deepcopy(profile))
    rng = Random(31)
    current = next_task(store, "reading", rng, step_by_step=True, reading_phrase=WeightedPhrase)
    for _ in range(12):
        following = next_task(store, "reading", rng, step_by_step=True, after_id=current["id"], reading_phrase=WeightedPhrase)
        assert [(n["start"], n["duration"]) for n in current["target"]] != [
            (n["start"], n["duration"]) for n in following["target"]
        ]
        current = following
    assert not store.attempts()


if __name__ == "__main__":
    main()
