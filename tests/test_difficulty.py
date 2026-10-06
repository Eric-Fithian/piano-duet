import pytest

from piano_duet.difficulty import PerformanceLimits


def main():
    raise SystemExit(pytest.main([__file__]))


def allows(limits, pitch, onset, earliest=0):
    return any(start <= onset <= end for start, end in limits.windows(pitch, earliest))


def test_gentle_uses_one_note_per_hand_and_slower_attacks():
    limits = PerformanceLimits(1, beat=0.5)
    limits.record(60, 0)
    assert allows(limits, 48, 20)
    assert not allows(limits, 64, 20)
    limits.record(48, 20)
    assert not allows(limits, 50, 40)
    assert not allows(limits, 62, 490)
    assert allows(limits, 62, 500)
    assert limits.duration_floor >= 370


def test_register_chord_span_and_leaps_are_constrained():
    limits = PerformanceLimits(2, beat=0.5)
    assert not allows(limits, 40, 0)
    assert not allows(limits, 80, 0)
    limits.record(60, 0)
    assert allows(limits, 67, 0)
    assert not allows(limits, 69, 0)
    limits.record(67, 0)
    assert not allows(limits, 64, 0)
    assert allows(limits, 55, 0)
    limits.record(55, 0)
    assert not allows(limits, 50, 0)
    assert not allows(limits, 79, 1000)
    assert allows(limits, 72, 1000)


def test_higher_levels_allow_faster_wider_replies():
    gentle = PerformanceLimits(1, beat=0.5)
    expert = PerformanceLimits(5, beat=0.5)
    for limits in (gentle, expert):
        limits.record(60, 0)
    assert not allows(gentle, 62, 100)
    assert allows(expert, 62, 100)
    assert not allows(gentle, 84, 1000)
    assert allows(expert, 84, 1000)
    assert not allows(expert, 60, 40)
    assert allows(expert, 60, 70)


def test_chords_near_a_time_segment_boundary_cannot_bypass_limits():
    limits = PerformanceLimits(1, beat=0.5)
    limits.record(60, 4980)
    assert allows(limits, 48, 5000, earliest=4980)
    limits.record(48, 5000)
    assert not allows(limits, 62, 5010, earliest=5000)
    assert allows(limits, 62, 5480, earliest=5000)


@pytest.mark.parametrize("level", [0, 6, True, 1.5])
def test_invalid_levels_fail(level):
    with pytest.raises(ValueError):
        PerformanceLimits(level, beat=0.5)


if __name__ == "__main__":
    main()
