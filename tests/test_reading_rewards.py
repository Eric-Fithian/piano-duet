import pytest

from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_rewards import level_progress, score_xp, stage_clear_xp


def main():
    raise SystemExit(pytest.main([__file__]))


def observations(*matched):
    return [{"index": i, "group": i, "matched": value} for i, value in enumerate(matched)]


def prompt(stage=1, rhythm=False, introduce=None):
    return {"family": "reading", "reading": {"stage_number": stage, "rhythm_required": rhythm, "introduce": introduce}}


UNAIDED = {"hearings": 0, "reveals": 0, "hints": 0}


def assessment(matched, rhythm=None):
    return {
        "score": {"first_try": sum(matched), "total": len(matched)},
        "rhythm": {"accuracy": rhythm},
        "observations": observations(*matched),
        "evidence": [],
    }


def test_a_perfect_timed_score_earns_notes_streak_rhythm_and_perfect_bonuses():
    xp = score_xp(prompt(stage=6, rhythm=True), assessment([True] * 8, rhythm=90), UNAIDED)
    items = {item["id"]: item["xp"] for item in xp["items"]}
    assert items == {"first_try": 160, "streak": 80, "rhythm": 72, "perfect": 80}
    assert xp["total"] == 392


def test_mistakes_break_the_streak_and_remove_the_perfect_bonus():
    xp = score_xp(prompt(), assessment([True, True, False, True, True, True]), UNAIDED)
    items = {item["id"]: item for item in xp["items"]}
    assert items["first_try"]["count"] == 5
    assert items["recovered"]["count"] == 1
    assert "streak" not in items and "perfect" not in items


def test_help_halves_the_reward_and_introductions_earn_a_flat_amount():
    full = score_xp(prompt(), assessment([True] * 4), UNAIDED)["total"]
    helped = score_xp(prompt(), assessment([True] * 4), {**UNAIDED, "hearings": 1})
    assert helped["items"][-1]["id"] == "assisted"
    assert helped["total"] == full - full // 2
    assert score_xp(prompt(introduce=60), assessment([True]), UNAIDED)["total"] == 30


def test_levels_require_progressively_more_xp():
    assert level_progress(0) == {"xp": 0, "level": 1, "into": 0, "needed": 400}
    assert level_progress(399)["level"] == 1
    assert level_progress(400) == {"xp": 400, "level": 2, "into": 0, "needed": 500}
    assert level_progress(900)["level"] == 3
    assert stage_clear_xp(2) > stage_clear_xp(1)


def test_profile_xp_counts_live_reading_and_drops_excluded_attempts():
    attempt = {
        "id": "a",
        "excluded": False,
        "created_at": 0,
        "prompt": prompt(),
        "context": {"source": "microphone", "interaction": "step_by_step", **UNAIDED},
        "assessment": assessment([True] * 4),
    }
    earned = score_xp(attempt["prompt"], attempt["assessment"], attempt["context"])["total"]
    assert reading_progress([attempt])["xp"]["xp"] == earned
    assert reading_progress([{**attempt, "excluded": True}])["xp"]["xp"] == 0
    whole_phrase = {**attempt, "context": {**attempt["context"], "interaction": None}}
    assert reading_progress([whole_phrase])["xp"]["xp"] == 0


if __name__ == "__main__":
    main()
