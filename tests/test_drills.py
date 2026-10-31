import json
from types import SimpleNamespace
from urllib.parse import quote
from uuid import uuid4

import numpy as np
import pytest
from fake_phrase import WeightedPhrase
from fastapi.testclient import TestClient
from pydantic import ValidationError

from piano_duet.drills import (
    CLEAN,
    DRILLS,
    STREAK,
    assess_drill,
    build_task,
    coach_config,
    describe_slips,
    drill_levels,
    drill_progress,
    ladder,
    rung_of,
    validate,
)
from piano_duet.key_tracking import MusicalKey
from piano_duet.notes import Note
from piano_duet.server import create_app

HEADERS = {"X-Duet-Client": "1"}
PCM = np.zeros(3200, dtype="<f4").tobytes()
QUALITY = {"usable": True, "reason": "Test input"}


def main():
    raise SystemExit(pytest.main([__file__]))


def config(**changes):
    return {"drill": "scale", "variant": "major", "tonic": 0, "hands": "right", "octaves": 1,
            "inversion": 0, "practice": "even", **changes}


def hand(task, which, field="pitch"):
    return [note.get(field) for note in task["target"] if note["hand"] == which]


def performance(task, tempo=1.0, wrong=()):
    notes = []
    for index, note in enumerate(task["target"]):
        notes.append({**note, "pitch": note["pitch"] + (1 if index in wrong else 0),
                      "start": note["start"] / tempo, "duration": note["duration"] / tempo})
    return notes


def attempt(task, notes, created_at, source="microphone"):
    context = {"source": source}
    return {
        "mode": "drills",
        "prompt": task,
        "notes": notes,
        "recognition": QUALITY,
        "excluded": False,
        "created_at": created_at,
        "context": context,
        "assessment": assess_drill(task, [Note.model_validate(n) for n in notes], context, QUALITY),
    }


def test_every_drill_fits_the_keyboard():
    for drill, spec in DRILLS.items():
        for variant in spec["variants"]:
            for tonic in range(12):
                for hands in spec["hands"]:
                    for octaves in spec["octaves"]:
                        current = config(drill=drill, variant=variant, tonic=tonic, hands=hands, octaves=octaves)
                        try:
                            validate(current)
                        except ValueError:
                            continue
                        task = build_task(current, len(ladder(drill)) - 1)
                        assert all(21 <= note["pitch"] <= 108 for note in task["target"])
                        assert task["target"][0]["start"] == 0


def test_standard_scale_fingerings():
    c = build_task(config(hands="together"), 0)
    assert hand(c, "right", "finger")[:8] == [1, 2, 3, 1, 2, 3, 4, 5]
    assert hand(c, "left", "finger")[:8] == [5, 4, 3, 2, 1, 3, 2, 1]
    b_flat = build_task(config(tonic=10, hands="together"), 0)
    assert hand(b_flat, "right", "finger")[:8] == [2, 1, 2, 3, 1, 2, 3, 4]
    assert hand(b_flat, "left", "finger")[:8] == [3, 2, 1, 4, 3, 2, 1, 3]
    assert hand(build_task(config(tonic=5), 0), "right", "finger")[:8] == [1, 2, 3, 4, 1, 2, 3, 4]
    assert hand(build_task(config(tonic=11, hands="left"), 0), "left", "finger")[:8] == [4, 3, 2, 1, 4, 3, 2, 1]
    two = hand(build_task(config(octaves=2), 0), "right", "finger")
    assert two[:15] == [1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4, 5]
    # Black-key minor fingerings differ between editions, so none is printed.
    assert set(hand(build_task(config(variant="harmonic minor", tonic=1), 0), "right", "finger")) == {None}


def test_scale_shapes():
    melodic = hand(build_task(config(variant="melodic minor", tonic=9), 0), "right")
    assert melodic == [69, 71, 72, 74, 76, 78, 80, 81, 79, 77, 76, 74, 72, 71, 69]
    contrary = build_task(config(hands="contrary", octaves=2), 0)
    assert hand(contrary, "left")[:3] == [60, 59, 57] and hand(contrary, "right")[:3] == [60, 62, 64]
    third = build_task(config(hands="third"), 0)
    assert hand(third, "right")[0] - hand(third, "left")[0] == 16
    sixth = build_task(config(hands="sixth"), 0)
    assert hand(sixth, "right")[0] - hand(sixth, "left")[0] == 8
    with pytest.raises(ValueError):
        validate(config(variant="melodic minor", hands="contrary"))
    with pytest.raises(ValueError):
        validate(config(hands="contrary", octaves=3))


def test_chords_cadence_and_hanon():
    cadence = build_task(config(drill="cadence", hands="together"), 0)
    chords = [sorted(n["pitch"] for n in cadence["target"] if n["start"] == start and n["hand"] == "right")
              for start in sorted({n["start"] for n in cadence["target"]})]
    assert chords == [[60, 64, 67], [60, 65, 69], [59, 65, 67], [60, 64, 67]]
    assert hand(cadence, "left") == [48, 53, 55, 48]
    broken = build_task(config(drill="broken_chord"), 0)
    # Up through the inversions to the octave, then down through the same positions, turning within the top one.
    assert hand(broken, "right") == [60, 64, 67, 64, 67, 72, 67, 72, 76, 72, 76, 79,
                                     79, 76, 72, 76, 72, 67, 72, 67, 64, 67, 64, 60]
    assert hand(broken, "right", "finger")[9:15] == [1, 3, 5, 5, 3, 1]
    # Twenty-four triplets fill two bars exactly; the last note ends the second.
    last = broken["target"][-1]
    assert last["start"] + last["duration"] == pytest.approx(8 * 60 / broken["bpm"])
    inversions = build_task(config(drill="block_chord"), 0)
    assert hand(inversions, "right", "finger")[3:6] == [1, 2, 5]
    hanon = build_task(config(drill="hanon"), 0)
    assert hand(hanon, "right")[:16] == [60, 64, 65, 67, 69, 67, 65, 64, 62, 65, 67, 69, 71, 69, 67, 65]
    descent = hand(hanon, "right")[56:64]
    assert descent == [79, 76, 74, 72, 71, 72, 74, 76]
    assert hand(hanon, "right", "finger")[56:64] == [5, 4, 3, 2, 1, 2, 3, 4]


def test_rhythm_and_accent_practice():
    dotted = build_task(config(practice="long-short"), rung_of("scale", 4, 60))
    assert dotted["drill"]["per_beat"] == 2
    starts = [n["start"] for n in dotted["target"]]
    assert starts[1] - starts[0] == pytest.approx(0.75) and starts[2] - starts[1] == pytest.approx(0.25)
    accents = build_task(config(practice="accent-3"), 0)
    assert [n["velocity"] for n in accents["target"][:4]] == [100, 60, 60, 100]


def test_three_clean_takes_in_a_row_climb_and_empty_takes_step_back():
    start = rung_of("scale", 2, 60)
    first = build_task(config(), start)
    attempts = [attempt(first, performance(first), at) for at in range(1, STREAK)]
    assert all(a["assessment"]["drill"]["clean"] for a in attempts)
    progress, _ = drill_progress(attempts)
    assert progress["scale|major|0|right|1|0"]["working"] == start
    assert progress["scale|major|0|right|1|0"]["streak"] == STREAK - 1
    attempts.append(attempt(first, performance(first), STREAK))
    progress, practice_days = drill_progress(attempts)
    entry = progress["scale|major|0|right|1|0"]
    assert entry["working"] == start + 1 and entry["best"] == start and practice_days == 1
    wrong = build_task(config(), entry["working"], entry)
    attempts += [attempt(wrong, performance(wrong, wrong={1, 3, 5}), at) for at in (10, 11)]
    assert not attempts[-1]["assessment"]["drill"]["clean"]
    assert drill_progress(attempts)[0]["scale|major|0|right|1|0"]["working"] == start
    dotted = build_task(config(practice="long-short"), start)
    assert not attempt(dotted, performance(dotted), 12)["assessment"]["drill"]["clean"]
    assert drill_progress([attempt(first, performance(first), 1, "demo")])[0] == {}


def test_practice_days_count_distinct_included_drill_days_even_after_a_gap():
    task = build_task(config(), 0)
    notes = performance(task)
    first = 1700000000
    takes = [attempt(task, notes, first), attempt(task, notes, first + 60),
             attempt(task, notes, first + 7 * 86400)]
    excluded = attempt(task, notes, first + 14 * 86400)
    excluded["excluded"] = True
    demo = attempt(task, notes, first + 21 * 86400, "demo")
    empty = {**takes[0], "created_at": first + 28 * 86400, "notes": []}
    other = {**takes[0], "created_at": first + 35 * 86400, "mode": "reading"}
    assert drill_progress([])[1] == 0
    assert drill_progress(takes + [excluded, demo, empty, other])[1] == 2


def test_tempo_is_the_players_own_and_credited_as_played():
    suggested = build_task(config(), rung_of("scale", 2, 80))
    slow = [attempt(suggested, performance(suggested, tempo=0.9), at) for at in range(STREAK)]
    result = slow[0]["assessment"]["drill"]
    assert result["clean"] and result["played_bpm"] == 72 and "Clean and steady at ♩ 72" in slow[0]["assessment"]["feedback"]
    entry = drill_progress(slow)[0]["scale|major|0|right|1|0"]
    assert entry["best_tempo"] == {"per_beat": 2, "bpm": 72} and entry["working_tempo"] == {"per_beat": 2, "bpm": 76}
    fast = [attempt(suggested, performance(suggested, tempo=1.25), at) for at in range(STREAK)]
    assert drill_progress(fast)[0]["scale|major|0|right|1|0"]["best_tempo"] == {"per_beat": 2, "bpm": 100}


def drifting(task, change):
    """Stretch each gap a little more than the last, so the tempo slides by `change` over the take."""
    played, clock = [], 0.0
    starts = sorted({n["start"] for n in task["target"]})
    for index, start in enumerate(starts):
        if index:
            clock += (start - starts[index - 1]) * (1 + change * index / len(starts))
        played += [{**n, "start": clock} for n in task["target"] if n["start"] == start]
    return played


def test_a_slow_drift_is_not_steady():
    task = build_task(config(octaves=2), rung_of("scale", 2, 80))
    steady = attempt(task, performance(task), 1)["assessment"]
    assert steady["drill"]["drift_percent"] == 0 and steady["drill"]["evenness"] == 100
    slowing = attempt(task, drifting(task, 0.25), 2)["assessment"]
    assert slowing["drill"]["drift_percent"] < -CLEAN["drift"]
    # Judged against its own neighbourhood, each gap is still even; only the drift fails it.
    assert slowing["drill"]["evenness"] >= CLEAN["evenness"] and not slowing["drill"]["clean"]
    assert "slowed down" in slowing["feedback"]
    assert slowing["drill"]["issues"][0].startswith("The tempo slowed down")


def test_slips_are_named_by_what_happened():
    names = MusicalKey(0, "major").to_dict()
    chord = {"pitches": [64, 67, 72], "missed": [], "extra": [], "inserted": []}
    assert describe_slips({**chord, "missed": [72], "extra": [71]}, names) == [(10, "Played B4 instead of C5")]
    assert describe_slips({**chord, "extra": [71]}, names) == [(9, "Caught B4 beside C5")]
    assert describe_slips({**chord, "extra": [52]}, names)[0][1].startswith("Heard an extra E3, an octave from E4")
    assert describe_slips({**chord, "inserted": [[64, 67, 71]]}, names) == [
        (10, "Played E4 + G4 + B4 first, then corrected it to E4 + G4 + C5")]
    assert describe_slips({**chord, "missed": [64, 67, 72]}, names) == [(10, "Missed E4 + G4 + C5")]


def test_a_corrected_chord_is_named_once():
    task = build_task(config(drill="block_chord"), 0)
    played = performance(task)
    second = [n for n in played if n["step"] == 1]
    wrong = [{**n, "pitch": 71 if n["pitch"] == 72 else n["pitch"], "start": n["start"] - 0.6} for n in second]
    for note in played:
        if note["step"] >= 1:
            note["start"] += 0.6
    result = attempt(task, played + wrong, 1)["assessment"]["drill"]
    assert "Played E4 + G4 + B4 first, then corrected it to E4 + G4 + C5 in bar 1" in result["issues"]
    assert not any(issue.startswith("Pause before") for issue in result["issues"])


def test_a_note_played_twice_is_named_and_a_tempo_just_under_a_mark_reaches_it():
    task = build_task(config(), rung_of("scale", 2, 60))
    played = performance(task)
    early = {**played[0], "start": played[0]["start"]}
    for note in played:
        note["start"] += 0.25
    result = attempt(task, [early, *played], 1)["assessment"]["drill"]
    assert "Played C4 twice in bar 1" in result["issues"]
    slow = attempt(task, performance(task, tempo=0.98), 2)["assessment"]["drill"]
    assert slow["clean"] and slow["credit"] == rung_of("scale", 2, 60)


def test_levels_need_more_keys_and_tempo_and_the_coach_stays_varied():
    attempts = []
    for tonic in (0, 7):
        task = build_task(config(drill="five_finger", tonic=tonic), 0)
        attempts += [attempt(task, performance(task), len(attempts)) for _ in range(STREAK)]
    progress, _ = drill_progress(attempts)
    levels = drill_levels(progress)
    # Two keys at the starting tempo earn level 1; level 2 also asks for a faster tempo.
    assert levels["five_finger"]["level"] == 1
    upcoming = levels["five_finger"]["next"]
    assert upcoming["level"] == 2 and upcoming["keys"] == 2 and upcoming["done"] == 0
    assert upcoming["tempo"] == {"per_beat": 1, "bpm": 80}
    assert levels["scale"]["level"] == 0 and levels["scale"]["next"]["keys"] == 1
    config_, reason = coach_config(progress, levels, now=1000)
    assert config_["drill"] == "scale" and "not been tried" in reason
    config_, _ = coach_config(progress, levels, avoid=["scale"], now=1000)
    assert config_["drill"] in ("broken_chord", "block_chord")
    # The less-practised hand gets its turn, starting from the first key of the circle.
    config_, _ = coach_config(progress, levels, avoid=["scale", "broken_chord", "block_chord"], now=1000)
    assert config_ == config(drill="five_finger", hands="left")


def test_wrong_notes_and_unison_contrary_motion():
    task = build_task(config(), 0)
    result = attempt(task, performance(task, wrong={2, 5}), 1)["assessment"]
    assert not result["drill"]["clean"] and "did not match" in result["feedback"]
    contrary = build_task(config(hands="contrary"), 0)
    played = {(n["pitch"], n["start"]): n for n in performance(contrary)}
    result = attempt(contrary, list(played.values()), 1)["assessment"]
    assert result["score"]["pitch_accuracy"] == 100 and result["drill"]["sync_ms"] == 0


def test_timing_profile_points_at_pauses_misses_and_crossings():
    task = build_task(config(octaves=2), rung_of("scale", 2, 60))
    played = performance(task)
    # Hold back every note from the eighth onwards (the first thumb crossing at C5) by 0.4 s.
    for note in played[7:]:
        note["start"] += 0.4
    del played[20]
    assessment = attempt(task, played, 1)["assessment"]
    result = assessment["drill"]
    assert not result["clean"]
    flags = [row for row in result["timeline"] if row["flag"] == "late"]
    assert [row["index"] for row in flags] == [7]
    assert result["issues"][0].startswith("Missed")
    assert "Pause before C5 in bar 1: 400 ms late" in result["issues"]
    assert sum(row["missed"] for row in result["timeline"]) == 1
    even = attempt(task, performance(task), 2)["assessment"]["drill"]
    assert even["issues"] == [] and even["crossing_ms"] == 0


def test_the_timeline_shows_where_the_tempo_changed():
    task = build_task(config(octaves=2), rung_of("scale", 2, 60))
    played = performance(task)
    # Steady for the first half, then a quarter faster.
    half = len(played) // 2
    split = played[half]["start"]
    for note in played[half:]:
        note["start"] = split + (note["start"] - split) / 1.25
    result = attempt(task, played, 1)["assessment"]["drill"]
    tempos = [row["tempo"] for row in result["timeline"]]
    written = task["bpm"]
    assert all(abs(tempo - written) < 1 for tempo in tempos[2 : half - 1])
    assert all(abs(tempo - written * 1.25) < 1 for tempo in tempos[half + 2 :])
    assert result["targets"] == {"pitch": 90, "evenness": 80, "drift": 8}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("piano_duet.server.SAMPLES", tmp_path)
    monkeypatch.setattr("piano_duet.server.NOTATION", tmp_path)
    engine = SimpleNamespace(notes=[])
    engine.generator = SimpleNamespace(phrase=WeightedPhrase)
    # No last_quality: drill takes must not depend on the live model having transcribed anything yet.
    engine.transcriber = SimpleNamespace(transcribe=lambda *args, **kwargs: engine.notes)
    # Drill takes are transcribed by Transkun; the fake returns the same notes from 44.1 kHz audio.
    recording = SimpleNamespace(transcribe=lambda audio, cancel, progress: engine.notes)
    monkeypatch.setattr("piano_duet.server.RecordingTranscriber", lambda: recording)
    with TestClient(
        create_app(engine_factory=lambda: engine, profile_path=tmp_path / "learner.sqlite3")
    ) as result:
        result.engine = engine
        yield result


def submit(client, task, mode="drills", listening=None):
    extra = f"&listening={quote(json.dumps(listening))}" if listening else ""
    return client.post(
        f"/api/respond?mode={mode}&session={uuid4()}&task={task['id']}&attempt={uuid4()}{extra}",
        content=PCM,
        headers=HEADERS,
    )


def test_a_take_keeps_what_the_live_attack_counter_heard(client):
    task = client.post("/api/drills/next", json={}, headers=HEADERS).json()
    client.engine.notes = [Note.model_validate(n) for n in task["target"]]
    listening = {"ended": "attacks", "floor": 0.0091, "noise": 0.003, "attacks": [0.22, 0.6], "strengths": [0.03, 0.02], "seconds": 1.2}
    assert submit(client, task, "practice", listening).status_code == 400
    with pytest.raises(ValidationError):
        submit(client, task, "drills", {**listening, "ended": "silence"})
    response = submit(client, task, listening=listening)
    events = [json.loads(line) for line in response.text.splitlines()]
    attempt_id = next(event["id"] for event in events if event["type"] == "attempt")
    assert client.get(f"/api/attempts/{attempt_id}").json()["context"]["audio"]["listening"] == listening


def test_drill_flow_moves_the_working_tempo(client):
    catalog = client.get("/api/drills").json()
    assert set(catalog["catalog"]["drills"]) == set(DRILLS) and catalog["progress"] == {}
    chosen = client.post("/api/drills/next", json={}, headers=HEADERS).json()
    assert chosen["drill"]["drill"] in DRILLS
    request = {key: chosen["drill"][key] for key in ("drill", "variant", "tonic", "hands", "octaves", "inversion", "practice")}
    task = client.post("/api/drills/next", json=request, headers=HEADERS).json()
    client.engine.notes = [Note.model_validate(n) for n in task["target"]]
    assert submit(client, task, "practice").status_code == 400
    for take in range(STREAK):
        if take:
            again = client.post("/api/drills/next", json=request, headers=HEADERS).json()
            assert again["drill"]["rung"] == task["drill"]["rung"] and again["drill"]["streak"] == take
            task = again
        response = submit(client, task)
        assert response.status_code == 200
        assert '"clean": true' in response.text
    summary = client.get("/api/drills").json()
    progress = summary["progress"][task["drill"]["config_key"]]
    assert progress["working"] == task["drill"]["rung"] + 1
    assert summary["levels"][task["drill"]["drill"]]["level"] == 1 and summary["practice_days"] == 1
    again = client.post("/api/drills/next", json=request, headers=HEADERS).json()
    assert again["drill"]["rung"] == task["drill"]["rung"] + 1
    events = [json.loads(line) for line in response.text.splitlines()]
    attempt_id = next(event["id"] for event in events if event["type"] == "attempt")
    saved = client.get(f"/api/attempts/{attempt_id}").json()
    assert saved["recognition"]["model"] == "Transkun 2.0"
    profile = client.get("/api/profile").json()
    assert any(s["id"] == "technique.evenness" and s["attempts"] for s in profile["skills"])
    assert profile["practice_recent"] == []


def test_drill_requests_are_validated(client):
    bad = {**dict(config(variant="melodic minor", hands="contrary"))}
    assert client.post("/api/drills/next", json=bad, headers=HEADERS).status_code == 400
    assert client.post("/api/drills/next", json={"drill": "scale"}, headers=HEADERS).status_code == 422
    assert client.post("/api/drills/next", json={"rung": 3}, headers=HEADERS).status_code == 422
    practice = client.post("/api/practice/next", json={"focus": "technique"}, headers=HEADERS).json()
    assert submit(client, practice).status_code == 400


if __name__ == "__main__":
    main()
