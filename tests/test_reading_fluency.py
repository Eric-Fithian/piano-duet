import random
from copy import deepcopy
from statistics import mean

import pytest
from fake_phrase import WeightedPhrase

from piano_duet.practice import next_task
from piano_duet.profile import LearnerStore
from piano_duet.reading import assess_reading
from piano_duet.reading_curriculum import (
    VOCABULARIES,
    WHITE_KEYS,
    choose_position_change,
    measure_landings,
    reading_progress,
    summarize_fluency,
)

TIMES = [0.6, 1.2, 1.8, 2.4, 3.9, 4.5, 5.1, 5.7]


def main():
    raise SystemExit(pytest.main([__file__]))


@pytest.fixture(autouse=True)
def two_bars(monkeypatch):
    """These timings measure one hand-position change, so the foundation scores keep two bars."""
    monkeypatch.setattr("piano_duet.reading_curriculum.BARS", 2)


@pytest.fixture
def task(tmp_path):
    return next_task(LearnerStore(tmp_path / "learner.sqlite3"), "reading", random.Random(4), reading_phrase=WeightedPhrase)


def assess(task, times=TIMES, missed=(), interruptions=(), confidence=None, hints=0):
    groups = []
    for index, (note, time) in enumerate(zip(task["target"], times, strict=True)):
        if index in missed:
            groups.append(
                [
                    {
                        "pitch": note["pitch"] + 1,
                        "start": time - 0.15,
                        "velocity": 80,
                        "confidence": 0.95,
                    }
                ]
            )
        groups.append(
            [
                {
                    "pitch": note["pitch"],
                    "start": time,
                    "velocity": 80,
                    "confidence": (confidence or {}).get(index, 0.95),
                }
            ]
        )
    context = {
        **task["context"],
        "hints": hints,
        "reading_timing": {"interruptions": list(interruptions)},
    }
    return assess_reading(task, groups, context)[0]


def test_hesitation_is_relative_to_the_players_pulse_and_preserves_accuracy(task):
    result = assess(task)
    change = result["fluency"][0]
    assert result["score"]["score"] == 100
    assert result["score"]["rhythm_accuracy"] is None
    assert change["extra_seconds"] == 0.9
    assert change["extra_beats"] == 1.5
    assert change["bpm"] == 100
    assert change["finger"] == task["target"][4]["finger"]
    assert (
        change["shift_steps"]
        == task["reading"]["positions"][1]["low"] - task["reading"]["positions"][0]["low"]
    )
    slower = assess(task, [time * 2 + 1000 for time in TIMES])["fluency"][0]
    assert slower["extra_seconds"] == 1.8
    assert slower["extra_beats"] == change["extra_beats"]
    assert slower["bpm"] == 50
    assert {item["skill"] for item in result["evidence"]} == {"reading.pitch"}


@pytest.mark.parametrize(
    "options,reason",
    [
        ({"missed": (0,)}, "correction"),
        ({"missed": (4,)}, "correction"),
        ({"interruptions": (2,)}, "interrupted"),
        ({"interruptions": (4,)}, "interrupted"),
        ({"confidence": {2: 0.7}}, "uncertain"),
        ({"hints": 1}, "Assisted"),
        ({"times": [0.6, 1.2, 2.5, 3.1, 4.6, 5.2, 5.8, 6.4]}, "steady"),
        ({"times": [0.6, 1.2, 1.8, 2.4, 9.5, 10.1, 10.7, 11.3]}, "long pause"),
        ({"times": [0.6, 1.2, 1.8, 2.4, 2.6, 3.2, 3.8, 4.4]}, "ahead"),
    ],
)
def test_ambiguous_timing_is_left_unmeasured(task, options, reason):
    result = assess(task, **options)
    change = result["fluency"][0]
    assert change["extra_seconds"] is None
    assert change["extra_beats"] is None
    assert change["bpm"] is None
    assert reason in change["reason"]
    assert result["score"]["score"] == (88 if "missed" in options else 100)


def test_interruptions_and_mistakes_after_the_landing_do_not_discard_clean_timing(task):
    result = assess(task, interruptions=(0, 6), missed=(7,))
    assert result["fluency"][0]["extra_seconds"] == 0.9


@pytest.mark.parametrize(
    "options",
    [
        {"missed": (0, 2, 3)},
        {"missed": (4,)},
        {"interruptions": (0, 2, 5, 7)},
        {"confidence": {0: 0.1, 1: 0.1, 2: 0.1, 5: 0.1, 6: 0.1, 7: 0.1}},
        {"times": [0.1, 1.8, 2.1, 2.4, 3.9, 4.2, 8.5, 20]},
        {"hints": 1},
    ],
)
def test_landing_time_depends_only_on_the_two_attacks_at_the_change(task, options):
    change = assess(task, **options)["fluency"][0]
    assert change["arrival_seconds"] == 1.5
    assert change["arrival_reason"] is None
    assert summarize_fluency([change])["landings"][0]["samples"] == 1


@pytest.mark.parametrize(
    "options,reason",
    [
        ({"interruptions": (4,)}, "interrupted"),
        ({"confidence": {3: 0.7}}, "uncertain"),
        ({"confidence": {4: 0.7}}, "uncertain"),
        ({"times": [0.6, 1.2, 1.8, 2.4, 17.4, 18, 18.6, 19.2]}, "long pause"),
    ],
)
def test_landing_time_rejects_only_unreliable_change_measurements(task, options, reason):
    change = assess(task, **options)["fluency"][0]
    assert change["arrival_seconds"] is None
    assert reason in change["arrival_reason"]
    assert summarize_fluency([change])["landings"] == []


def test_early_arrival_and_slow_valid_arrival_do_not_need_a_tempo_baseline(task):
    for gap in (0.2, 7):
        times = [0.6, 1.2, 1.8, 2.4, *[2.4 + gap + offset * 0.6 for offset in range(4)]]
        change = assess(task, times)["fluency"][0]
        assert change["arrival_seconds"] == gap
        assert change["extra_seconds"] is None
        assert summarize_fluency([change])["landings"][0]["arrival_seconds"] == gap


def test_saved_landings_are_recalculated_without_rewriting_the_record(task):
    assessment = assess(task, missed=(0,))
    assessment["fluency"][0]["arrival_seconds"] = None
    assessment["fluency"][0].pop("arrival_reason")
    attempt = {
        "id": "reading-attempt",
        "created_at": 1000,
        "excluded": False,
        "prompt": task,
        "context": {
            **task["context"],
            "source": "microphone",
            "reading_timing": {"interruptions": []},
        },
        "assessment": assessment,
    }
    saved = deepcopy(attempt)
    hand = reading_progress([attempt])["hands"][task["reading"]["clef"]]
    assert hand["fluency"]["samples"] == 0
    assert hand["fluency"]["landings"][0]["arrival_seconds"] == 1.5
    assert hand["fluency"]["landings"][0]["samples"] == 1
    assert attempt == saved
    attempt["excluded"] = True
    assert (
        reading_progress([attempt])["hands"][task["reading"]["clef"]]["fluency"]["landings"] == []
    )


def test_missing_continuity_or_simultaneous_attacks_cannot_create_a_landing(task):
    assessment = assess(task)
    changes, observations = assessment["fluency"], assessment["observations"]
    assert measure_landings(changes, observations, {})[0]["arrival_seconds"] is None
    observations[4]["heard_at"] = observations[3]["heard_at"]
    change = measure_landings(changes, observations, {"reading_timing": {"interruptions": []}})[0]
    assert change["arrival_seconds"] is None
    assert "separately" in change["arrival_reason"]


def test_introductions_do_not_count_as_reading_landings(task):
    assessment = assess(task)
    change = measure_landings(
        assessment["fluency"],
        assessment["observations"],
        {"introduction": True, "reading_timing": {"interruptions": []}},
    )[0]
    assert change["arrival_seconds"] is None
    assert "introductions" in change["arrival_reason"]


def test_written_spacing_is_respected_and_slow_steady_playing_has_no_extra_pause(task):
    for index in range(4, 8):
        task["target"][index]["start"] += 1
    result = assess(task, [0.5, 2, 3.5, 5, 8, 9.5, 11, 12.5])
    assert result["fluency"][0]["extra_seconds"] == 0
    assert result["fluency"][0]["bpm"] == 40


def test_summary_compares_equal_windows_and_keeps_context_without_counting_untimed(task):
    change = assess(task)["fluency"][0]
    history = [{**change, "extra_seconds": 0.8, "extra_beats": 1.6}] * 5
    history += [{**change, "extra_seconds": 0.3, "extra_beats": 0.6}] * 5
    history.append({**change, "extra_seconds": None, "extra_beats": None, "bpm": None})
    result = summarize_fluency(history)
    assert result["samples"] == 10 and result["untimed"] == 1
    assert result["extra_seconds"] == 0.3 and result["previous_seconds"] == 0.8
    assert result["extra_beats"] == 0.6 and result["previous_beats"] == 1.6
    assert result["recent_samples"] == 5
    assert result["transitions"][0]["samples"] == 10
    assert result["transitions"][0]["extra_beats"] == 0.6


def test_repeated_hesitation_gets_more_practice_but_a_single_slow_change_does_not():
    hand = reading_progress([])["hands"]["treble"]
    hand["vocabulary"] = VOCABULARIES["treble"]
    previous = WHITE_KEYS.index(60)
    cue = {"pitch": 64, "finger": 2, "shift_steps": 1, "extra_beats": 3, "samples": 2}

    def occurrences():
        return sum(
            choose_position_change(hand, "treble", previous, random.Random(seed))
            == (64, previous + 1)
            for seed in range(500)
        )

    baseline = occurrences()
    hand["fluency"]["transitions"] = [cue]
    assert occurrences() == baseline
    cue["samples"] = 3
    assert occurrences() > baseline * 2


def test_larger_shifts_become_more_likely_after_both_accuracy_and_fluency_are_established():
    hand = reading_progress([])["hands"]["treble"]
    hand["vocabulary"] = VOCABULARIES["treble"]
    previous = WHITE_KEYS.index(60)
    fluent = deepcopy(hand)
    fluent["shifts"]["ready"] = True
    fluent["fluency"].update(samples=10, extra_beats=0.1)

    def distance(profile):
        return mean(
            abs(
                choose_position_change(profile, "treble", previous, random.Random(seed))[1]
                - previous
            )
            for seed in range(500)
        )

    assert distance(fluent) > distance(hand) * 1.5
    fluent["shifts"]["ready"] = False
    assert distance(fluent) == distance(hand)


def test_landing_map_combines_fingers_and_halves_older_influence_after_five_changes(task):
    change = assess(task)["fluency"][0]
    history = [{**change, "arrival_seconds": 2, "extra_seconds": 1.4, "extra_beats": 2.33}]
    history += [
        {
            **change,
            "finger": finger,
            "arrival_seconds": 1,
            "extra_seconds": 0.4,
            "extra_beats": 0.67,
        }
        for finger in range(1, 6)
    ]
    summary = summarize_fluency(history)
    assert len(summary["landings"]) == 1
    landing = summary["landings"][0]
    assert landing["samples"] == 6
    assert landing["arrival_seconds"] == 1.5
    assert summary["outliers"] == 0


def test_arrival_outliers_and_average_do_not_require_extra_pause_estimates(task):
    change = {
        **assess(task)["fluency"][0],
        "arrival_seconds": 0.8,
        "extra_seconds": None,
        "extra_beats": None,
        "bpm": None,
    }
    spike = {**change, "arrival_seconds": 4.6}
    summary = summarize_fluency([change] * 6 + [spike] + [change] * 2)
    assert summary["samples"] == 0
    assert summary["landings"][0] == {
        "pitch": change["pitch"],
        "samples": 8,
        "arrival_seconds": 0.8,
        "outliers": 1,
    }
    repeated = summarize_fluency([change] * 6 + [spike] * 2)["landings"][0]
    assert repeated["samples"] == 8 and repeated["outliers"] == 0
    assert repeated["arrival_seconds"] > 0.8


def test_isolated_outliers_and_breaks_do_not_change_averages_or_practice_targets(task):
    change = assess(task)["fluency"][0]
    clean = {**change, "arrival_seconds": 0.8, "extra_seconds": 0.2, "extra_beats": 1 / 3}
    spike = {**change, "arrival_seconds": 4.6, "extra_seconds": 4, "extra_beats": 4 / 0.6}
    pause = {**change, "arrival_seconds": 15, "extra_seconds": 14.4, "extra_beats": 24}
    summary = summarize_fluency([clean] * 6 + [spike, pause] + [clean] * 2)
    assert summary["samples"] == 8
    assert summary["outliers"] == 2
    assert summary["extra_seconds"] == 0.2
    assert summary["landings"][0]["arrival_seconds"] == 0.8
    assert summary["landings"][0]["outliers"] == 2
    assert summary["transitions"][0]["samples"] == 8
    assert summarize_fluency([pause])["landings"][0]["arrival_seconds"] is None


def test_consistently_slow_changes_are_not_mistaken_for_outliers(task):
    change = assess(task)["fluency"][0]
    clean = {**change, "arrival_seconds": 0.8, "extra_seconds": 0.2}
    slow = {**change, "arrival_seconds": 4.6, "extra_seconds": 4}
    summary = summarize_fluency([clean] * 6 + [slow] * 2)
    assert summary["outliers"] == 0
    assert summary["landings"][0]["arrival_seconds"] > 0.8
    separate_note = {**slow, "pitch": change["pitch"] + 2}
    summary = summarize_fluency([clean] * 6 + [separate_note] * 5)
    assert summary["outliers"] == 0
    assert len(summary["landings"]) == 2


def test_fifteen_second_break_is_untimed_even_with_a_very_slow_reference_bar(task):
    result = assess(task, [0.5, 4.5, 8.5, 12.5, 27.5, 31.5, 35.5, 39.5])
    assert result["score"]["score"] == 100
    assert len(result["fluency"]) == 1
    assert result["fluency"][0]["arrival_seconds"] is None
    assert "long pause" in result["fluency"][0]["reason"]


def test_changes_with_and_without_a_suggested_finger_summarize_together(task):
    # From the key-signature stages fingering is the player's choice, so a change may carry no finger.
    change = assess(task)["fluency"][0]
    history = [{**change, "finger": 3, "extra_seconds": 0.4, "extra_beats": 0.8}] * 3
    history += [{**change, "finger": None, "extra_seconds": 0.2, "extra_beats": 0.4}] * 3
    transitions = summarize_fluency(history)["transitions"]
    assert [row["finger"] for row in transitions] == [None, 3]


if __name__ == "__main__":
    main()
