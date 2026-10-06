import json
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest
from fastapi.testclient import TestClient

from piano_duet.notes import Note
from piano_duet.server import DuetEngine, create_app

HEADERS = {"X-Duet-Client": "1"}
PCM = np.zeros(3200, dtype="<f4").tobytes()


def main():
    raise SystemExit(pytest.main([__file__]))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("piano_duet.server.SAMPLES", tmp_path)
    monkeypatch.setattr("piano_duet.server.NOTATION", tmp_path)
    engine = DuetEngine.__new__(DuetEngine)
    engine.lesson = None
    engine.generator = None
    engine.notes = [Note(pitch=61, start=0, duration=0.4, velocity=80)]
    engine.transcriber = SimpleNamespace(transcribe=lambda *args, **kwargs: engine.notes)

    def analyze(generator, notes, threshold, cancel, on_note):
        detail = {"index": 0, "played": 61, "corrected": 60, "surprise": 0.99, "changed": True}
        on_note(detail, 1)
        return [notes[0].model_copy(update={"pitch": 60})], [detail]

    monkeypatch.setattr("piano_duet.server.analyze_phrase", analyze)
    with TestClient(create_app(engine_factory=lambda: engine)) as result:
        yield result


def request(client, session, lesson, stage="idea"):
    response = client.post(
        f"/api/respond?mode=learning&session={session}&lesson={lesson}&stage={stage}",
        content=PCM,
        headers=HEADERS,
    )
    assert response.status_code == 200
    return [json.loads(line) for line in response.text.splitlines()]


def test_full_learning_cycle_scores_once_then_accepts_another_idea(client):
    session, lesson = uuid4(), uuid4()
    events = request(client, session, lesson)
    assert [e["type"] for e in events] == ["heard", "analyzing", "lesson", "note", "done"]
    assert events[-2]["note"]["pitch"] == 60
    client.app.state.engine.notes = [Note(pitch=60, start=1, duration=0.4, velocity=80)]
    events = request(client, session, lesson, "repeat")
    assert [e["type"] for e in events] == ["heard", "score", "done"]
    assert events[1]["score"] == 100
    assert events[-1]["stage"] == "complete"
    assert client.app.state.engine.lesson is None
    assert request(client, session, lesson, "repeat")[0]["type"] == "error"
    assert request(client, session, uuid4())[-1]["stage"] == "repeat"


def test_another_session_cannot_score_against_the_pending_target(client):
    session, lesson = uuid4(), uuid4()
    request(client, session, lesson)
    assert request(client, uuid4(), lesson, "repeat")[0]["type"] == "error"
    assert client.app.state.engine.lesson is not None
    assert not client.get("/api/status").json()["busy"]


def test_empty_attempt_keeps_target_available_for_retry(client):
    session, lesson = uuid4(), uuid4()
    request(client, session, lesson)
    client.app.state.engine.notes = []
    events = request(client, session, lesson, "repeat")
    assert events[-1]["empty"]
    assert client.app.state.engine.lesson is not None
    assert not any(e["type"] == "score" for e in events)


def test_cancelled_idea_does_not_create_target(client):
    cancel = Event()
    cancel.set()
    events = []
    engine = client.app.state.engine
    engine.learn(np.zeros(3200), "session", "round", "idea", 0.98, 0.75, events.append, cancel)
    assert engine.lesson is None
    assert events == []


def test_learning_request_requires_explicit_round(client):
    response = client.post(
        f"/api/respond?mode=learning&session={uuid4()}", content=PCM, headers=HEADERS
    )
    assert response.status_code == 400


if __name__ == "__main__":
    main()
