import json
from random import Random
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest
from fake_phrase import WeightedPhrase
from fastapi.testclient import TestClient

from piano_duet.notes import Note
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import compose_reading, reading_attacks
from piano_duet.reading_stages import curriculum_progress, stage_by_id
from piano_duet.server import create_app

HEADERS = {"X-Duet-Client": "1"}
PCM = np.zeros(3200, dtype="<f4").tobytes()


def main():
    raise SystemExit(pytest.main([__file__]))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("piano_duet.server.SAMPLES", tmp_path)
    monkeypatch.setattr("piano_duet.server.NOTATION", tmp_path)
    engine = SimpleNamespace(notes=[])
    engine.compositions = []

    def phrase(rng, context=None):
        engine.compositions.append(WeightedPhrase(rng, context))
        return engine.compositions[-1]

    engine.generator = SimpleNamespace(phrase=phrase)
    engine.transcriber = SimpleNamespace(
        transcribe=lambda *args, **kwargs: engine.notes,
        listen=lambda audio, threshold: [
            {"pitch": 60, "start": 0.5, "velocity": 80, "confidence": threshold}
        ],
        last_quality={"usable": True, "reason": "Test input"},
    )
    with TestClient(
        create_app(engine_factory=lambda: engine, profile_path=tmp_path / "learner.sqlite3")
    ) as result:
        yield result


def submit(client, task, id_=None):
    return client.post(
        f"/api/respond?mode=practice&session={uuid4()}&task={task['id']}&attempt={id_ or uuid4()}",
        content=PCM,
        headers=HEADERS,
    )


def independent_reading(client):
    for _ in range(20):
        task = client.post(
            "/api/practice/next", json={"focus": "reading", "step_by_step": True}, headers=HEADERS
        ).json()
        if not task["context"]["introduction"]:
            return task
        response = client.post(
            "/api/reading/complete",
            json={
                "task": task["id"],
                "attempt": str(uuid4()),
                "threshold": 0.8,
                "interruptions": [],
                "groups": [
                    [
                        {
                            "pitch": note["pitch"],
                            "start": note["start"] + 0.5,
                            "velocity": 80,
                            "confidence": 0.9,
                        }
                    ]
                    for note in task["target"]
                ],
            },
            headers=HEADERS,
        )
        assert response.status_code == 200
        assert not response.json()["assessment"]["evidence"]
    raise AssertionError("Introductions must lead to an independent score")


@pytest.mark.parametrize(
    "stage",
    [stage_by_id(id_) for id_ in ("pairs", "together", "triplets", "expert")],
    ids=lambda stage: stage["id"],
)
def test_advanced_reading_submission_preserves_chords_rhythm_and_profile_evidence(client, stage):
    progress = reading_progress([])
    progress["curriculum"].update(current=stage["id"], number=stage["number"], target=stage["id"], target_number=stage["number"], contexts=[])
    task = compose_reading(progress, Random(1), WeightedPhrase)
    task.update(id=str(uuid4()), family="reading", purpose="Explore", context={
        "hearings": 0, "reveals": 0, "hints": 0, "familiar": False,
        "notation_visible": True, "interaction": "step_by_step", "introduction": False,
    })
    client.app.state.store.add_task(task)
    groups = [
        [{"pitch": task["target"][i]["pitch"], "start": attack["start"] + 1, "velocity": 80, "confidence": .95}
         for i in attack["indices"]]
        for attack in reading_attacks(task["target"])
    ]
    payload = {"task": task["id"], "attempt": str(uuid4()), "threshold": .8, "interruptions": [], "groups": groups}
    response = client.post("/api/reading/complete", json={**payload, "groups": groups[:-1]}, headers=HEADERS)
    assert response.status_code == 400
    assert not client.app.state.store.has_attempt(payload["attempt"])
    response = client.post("/api/reading/complete", json=payload, headers=HEADERS)
    assert response.status_code == 200
    assessment = response.json()["assessment"]
    assert assessment["score"]["pitch_accuracy"] == assessment["score"]["rhythm_accuracy"] == 100
    assert len(assessment["observations"]) == len(task["target"])
    assert {row["skill"] for row in assessment["evidence"]} == {"reading.pitch", "reading.rhythm"}
    earned = response.json()["xp"]
    assert {item["id"] for item in earned["items"]} >= {"first_try", "rhythm", "perfect"}
    profile = client.get("/api/profile").json()
    assert profile["reading"]["xp"]["xp"] == earned["total"]
    assert profile["reading"]["history"][-1]["id"] == payload["attempt"]
    assert profile["reading"]["curriculum"]["number"] == 1
    assert profile["reading"]["curriculum"]["path"][stage["number"] - 1]["groups"][0]["samples"] == (1 if task["reading"]["clef"] != "bass" else 0)
    detail = client.get(f"/api/attempts/{payload['attempt']}").json()
    assert detail["prompt"]["target"] == task["target"]


def test_full_practice_history_profile_exclusion_and_export_flow(client):
    task = client.post("/api/practice/next", json={"focus": "technique"}, headers=HEADERS).json()
    client.app.state.engine.notes = [Note.model_validate(n) for n in task["target"]]
    id_ = uuid4()
    response = submit(client, task, id_)
    assert response.status_code == 200
    events = [json.loads(line) for line in response.text.splitlines()]
    assert [event["type"] for event in events] == ["attempt", "heard", "assessment", "done"]
    assert events[2]["assessment"]["score"]["score"] == 100
    profile = client.get("/api/profile").json()
    assert profile["attempts"] == 1
    assert next(s for s in profile["skills"] if s["id"] == "technique.scales")["accuracy"] == 100
    detail = client.get(f"/api/attempts/{id_}").json()
    assert detail["prompt"]["target"] == task["target"] and detail["notes"] == task["target"]
    assert (
        client.post(
            f"/api/attempts/{id_}/exclude", json={"excluded": True}, headers=HEADERS
        ).json()["included_attempts"]
        == 0
    )
    assert client.get("/api/profile/export").json()["attempts"][0]["excluded"]
    assert submit(client, task, id_).status_code == 409
    assert submit(client, task).status_code == 409
    assert not client.get("/api/status").json()["busy"]


def test_reading_preview_is_saved_before_playing_and_requires_a_reading_predecessor(client):
    current = client.post(
        "/api/practice/next", json={"focus": "reading", "step_by_step": True}, headers=HEADERS
    ).json()
    request = {"focus": "reading", "step_by_step": True, "after": current["id"]}
    response = client.post("/api/practice/next", json=request, headers=HEADERS)
    assert response.status_code == 200
    preview = response.json()
    assert preview["id"] != current["id"]
    assert preview["reading"]["introduce"] != current["reading"]["introduce"]
    assert client.app.state.store.task(preview["id"])["target"] == preview["target"]
    assert client.get("/api/profile").json()["attempts"] == 0
    assert (
        client.post(
            "/api/practice/next", json={**request, "after": str(uuid4())}, headers=HEADERS
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/practice/next", json={**request, "step_by_step": False}, headers=HEADERS
        ).status_code
        == 400
    )
    technique = client.post(
        "/api/practice/next", json={"focus": "technique"}, headers=HEADERS
    ).json()
    assert (
        client.post(
            "/api/practice/next", json={**request, "after": technique["id"]}, headers=HEADERS
        ).status_code
        == 400
    )


def test_ear_requires_listening_and_reveal_changes_evidence(client):
    task = client.post("/api/practice/next", json={"focus": "ear"}, headers=HEADERS).json()
    assert submit(client, task).status_code == 400
    for kind in ("hearings", "reveals"):
        assert (
            client.post(
                f"/api/practice/{task['id']}/aid", json={"kind": kind}, headers=HEADERS
            ).status_code
            == 200
        )
    client.app.state.engine.notes = [Note.model_validate(n) for n in task["target"]]
    events = [json.loads(line) for line in submit(client, task).text.splitlines()]
    assert not any(e["skill"].startswith("ear.") for e in events[2]["assessment"]["evidence"])
    assert events[2]["assessment"]["score"]["score"] == 100


def test_empty_transcription_does_not_consume_the_exercise(client):
    task = client.post("/api/practice/next", json={"focus": "reading"}, headers=HEADERS).json()
    events = [json.loads(line) for line in submit(client, task).text.splitlines()]
    assert events[-1]["empty"]
    assert not client.app.state.store.task(task["id"])["completed"]
    assert all(s["level"] is None for s in client.get("/api/profile").json()["skills"])


def test_a_performance_can_be_kept_as_repertoire(client):
    task = client.post("/api/practice/next", json={"focus": "technique"}, headers=HEADERS).json()
    client.app.state.engine.notes = [Note.model_validate(n) for n in task["target"]]
    id_ = uuid4()
    submit(client, task, id_)
    piece = client.post(
        "/api/pieces", json={"attempt": str(id_), "title": "My melody"}, headers=HEADERS
    ).json()
    assert piece["title"] == "My melody"
    repertoire = client.post(
        "/api/practice/next", json={"focus": "repertoire", "piece": piece["id"]}, headers=HEADERS
    ).json()
    assert repertoire["target"] == piece["notes"]
    assert repertoire["family"] == "repertoire"


def test_profile_mutations_require_the_local_app_header(client):
    assert client.post("/api/practice/next", json={"focus": "reading"}).status_code == 403
    assert (
        client.post("/api/pieces", json={"attempt": str(uuid4()), "title": "No"}).status_code == 403
    )


def test_live_reading_waits_for_corrections_and_records_first_try_evidence(client):
    task = independent_reading(client)
    assert task["context"]["interaction"] == "step_by_step"
    assert "no time limit" in task["instruction"]
    groups = []
    for i, target in enumerate(task["target"]):
        if i == 0:
            groups.append(
                [{"pitch": target["pitch"] + 1, "start": 0.2, "velocity": 80, "confidence": 0.9}]
            )
        groups.append(
            [{"pitch": target["pitch"], "start": i + 0.8, "velocity": 80, "confidence": 0.9}]
        )
    payload = {
        "task": task["id"],
        "attempt": str(uuid4()),
        "groups": groups[:-1],
        "threshold": 0.8,
        "interruptions": [],
    }
    assert client.post("/api/reading/complete", json=payload, headers=HEADERS).status_code == 400
    payload["groups"] = groups
    result = client.post("/api/reading/complete", json=payload, headers=HEADERS)
    assert result.status_code == 200
    assessment = result.json()["assessment"]
    assert assessment["score"]["first_try"] == len(task["target"]) - 1
    assert assessment["score"]["rhythm_accuracy"] is None
    assert not assessment["observations"][0]["matched"]
    assert len(assessment["observations"][0]["tries"]) == 2
    assert {item["skill"] for item in assessment["evidence"]} == {"reading.pitch"}
    detail = client.get(f"/api/attempts/{payload['attempt']}").json()
    assert len(detail["notes"]) == len(task["target"]) + 1
    assert detail["context"]["interaction"] == "step_by_step"
    assert client.post("/api/reading/complete", json=payload, headers=HEADERS).status_code == 409
    next_ = client.post("/api/practice/next", json={"focus": "reading"}, headers=HEADERS).json()
    assert next_["target"] != task["target"]


def test_reading_uses_the_local_model_before_saving_the_visible_score(client):
    task = independent_reading(client)
    written = [(onset, pitch) for onset, pitch, _ in client.app.state.engine.compositions[-1].notes]
    assert [(note["start"], note["pitch"]) for note in task["target"]] == written
    assert task["reading"]["composition"] == {"method": "aria"}
    assert client.app.state.store.task(task["id"])["target"] == task["target"]
    assert client.get("/api/profile").json()["reading"]["rounds"] == 0
    preview = client.post(
        "/api/practice/next",
        json={"focus": "reading", "step_by_step": True, "after": task["id"]},
        headers=HEADERS,
    ).json()
    assert preview["target"] != task["target"]
    assert client.app.state.store.task(task["id"])["target"] == task["target"]


def test_live_listening_validates_pcm_and_accepts_stricter_thresholds(client):
    pcm = np.zeros(32000, dtype="<f4").tobytes()
    response = client.post("/api/reading/listen?threshold=0.95", content=pcm, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["notes"][0]["confidence"] == 0.95
    assert not client.get("/api/status").json()["busy"]
    assert client.post("/api/reading/listen", content=b"bad", headers=HEADERS).status_code == 400
    assert client.post("/api/reading/listen", content=pcm).status_code == 403
    assert (
        client.post("/api/reading/listen?threshold=1", content=pcm, headers=HEADERS).status_code
        == 422
    )


def test_fluency_is_saved_with_timing_context_and_exclusion_recalculates_it(client, monkeypatch):
    monkeypatch.setattr("piano_duet.reading_curriculum.BARS", 2)
    task = independent_reading(client)
    payload = {
        "task": task["id"],
        "attempt": str(uuid4()),
        "threshold": 0.8,
        "interruptions": [],
        "groups": [
            [
                {
                    "pitch": note["pitch"],
                    "start": 0.5 + index * 0.6 + (0.9 if index >= 4 else 0),
                    "velocity": 80,
                    "confidence": 0.95,
                }
            ]
            for index, note in enumerate(task["target"])
        ],
    }
    for interruptions in ([-1], [3, 2], [2, 2], [9]):
        response = client.post(
            "/api/reading/complete",
            json={**payload, "interruptions": interruptions},
            headers=HEADERS,
        )
        assert response.status_code == 422
    response = client.post("/api/reading/complete", json=payload, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["assessment"]["fluency"][0]["extra_seconds"] == 0.9
    assert response.json()["assessment"]["score"]["score"] == 100
    detail = client.get(f"/api/attempts/{payload['attempt']}").json()
    assert detail["context"]["reading_timing"] == {"interruptions": []}
    assert detail["reading_attacks"] == payload["groups"]
    hand = task["reading"]["clef"]
    assert client.get("/api/profile").json()["reading"]["hands"][hand]["fluency"]["samples"] == 1
    landings = client.get("/api/profile").json()["reading"]["hands"][hand]["fluency"]["landings"]
    assert len(landings) == 1
    assert landings[0]["pitch"] == task["target"][4]["pitch"]
    assert landings[0]["arrival_seconds"] == 1.5
    assert landings[0]["samples"] == 1
    client.post(
        f"/api/attempts/{payload['attempt']}/exclude", json={"excluded": True}, headers=HEADERS
    )
    assert client.get("/api/profile").json()["reading"]["hands"][hand]["fluency"]["samples"] == 0
    assert client.get("/api/profile").json()["reading"]["hands"][hand]["fluency"]["landings"] == []
    client.post(
        f"/api/attempts/{payload['attempt']}/exclude", json={"excluded": False}, headers=HEADERS
    )
    assert (
        client.get("/api/profile").json()["reading"]["hands"][hand]["fluency"]["extra_seconds"]
        == 0.9
    )


def test_landing_survives_irregular_playing_corrections_and_poor_later_recognition(client, monkeypatch):
    monkeypatch.setattr("piano_duet.reading_curriculum.BARS", 2)
    task = independent_reading(client)
    times = [0.5, 1.7, 1.9, 2.5, 3.7, 4, 7.3, 18]
    groups = []
    for index, (note, time) in enumerate(zip(task["target"], times, strict=True)):
        if index in (0, 4, 7):
            groups.append(
                [
                    {
                        "pitch": note["pitch"] + 1,
                        "start": time - 0.2,
                        "velocity": 80,
                        "confidence": 0.9,
                    }
                ]
            )
        groups.append(
            [
                {
                    "pitch": note["pitch"],
                    "start": time,
                    "velocity": 80,
                    "confidence": 0.1 if index > 4 else 0.95,
                }
            ]
        )
    attempt = str(uuid4())
    response = client.post(
        "/api/reading/complete",
        json={
            "task": task["id"],
            "attempt": attempt,
            "threshold": 0.8,
            "interruptions": [7],
            "groups": groups,
        },
        headers=HEADERS,
    )
    assert response.status_code == 200
    assessment = response.json()["assessment"]
    assert not assessment["quality"]["usable"]
    assert assessment["score"]["score"] < 100
    assert assessment["fluency"][0]["arrival_seconds"] == 1.2
    assert assessment["fluency"][0]["extra_seconds"] is None
    detail = client.get(f"/api/attempts/{attempt}").json()
    assert detail["assessment"]["fluency"][0]["arrival_seconds"] == 1.2
    hand = client.get("/api/profile").json()["reading"]["hands"][task["reading"]["clef"]]
    assert hand["fluency"]["samples"] == 0
    assert hand["fluency"]["landings"] == [
        {"pitch": task["target"][4]["pitch"], "samples": 1, "arrival_seconds": 1.2, "outliers": 0}
    ]
    client.post(f"/api/attempts/{attempt}/exclude", json={"excluded": True}, headers=HEADERS)
    hand = client.get("/api/profile").json()["reading"]["hands"][task["reading"]["clef"]]
    assert hand["fluency"]["landings"] == []


def test_octave_tolerance_matches_the_live_cursor_and_updates_reading_progress(client):
    task = independent_reading(client)
    groups = [
        [
            {"pitch": target["pitch"] + octave, "start": i + 0.4, "velocity": 80, "confidence": 0.9}
            for octave in (0, 12)
        ]
        for i, target in enumerate(task["target"])
    ]
    payload = {
        "task": task["id"],
        "attempt": str(uuid4()),
        "groups": groups,
        "threshold": 0.8,
        "interruptions": [],
    }
    response = client.post("/api/reading/complete", json=payload, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["assessment"]["score"]["score"] == 100
    progress = client.get("/api/profile").json()["reading"]
    assert progress["rounds"] == 1
    assert progress["notes"] == len(task["target"])
    client.post(
        f"/api/attempts/{payload['attempt']}/exclude", json={"excluded": True}, headers=HEADERS
    )
    assert client.get("/api/profile").json()["reading"]["accuracy"] is None


if __name__ == "__main__":
    main()


def test_reading_replays_earned_or_current_stages_but_never_locked_ones(client):
    request = {"focus": "reading", "step_by_step": True}
    task = client.post("/api/practice/next", json={**request, "stage": 1}, headers=HEADERS).json()
    assert task["reading"]["stage_number"] == 1
    assert client.post("/api/practice/next", json={**request, "stage": 2}, headers=HEADERS).status_code == 409
    assert client.post("/api/practice/next", json={**request, "stage": 25}, headers=HEADERS).status_code == 422
    assert client.post("/api/practice/next", json={"focus": "technique", "stage": 1}, headers=HEADERS).status_code == 400
    with pytest.raises(ValueError, match="locked"):
        curriculum_progress([], 2)
    assert curriculum_progress([], 1)["target_number"] == 1
