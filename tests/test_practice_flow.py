import json
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest
from fastapi.testclient import TestClient

from piano_duet.notes import Note
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
    engine.transcriber = SimpleNamespace(
        transcribe=lambda *args, **kwargs: engine.notes,
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


if __name__ == "__main__":
    main()
