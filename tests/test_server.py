import json
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest
from fastapi.testclient import TestClient

from piano_duet.notes import Note
from piano_duet.server import create_app

HEADERS = {"X-Duet-Client": "1", "Content-Type": "application/octet-stream"}
PCM = np.zeros(3200, dtype="<f4").tobytes()


def main():
    raise SystemExit(pytest.main([__file__]))


class RecordingEngine:
    def __init__(self):
        self.called = Event()
        self.audio = None
        self.history = []
        self.transcriber = SimpleNamespace(last_quality={"usable": True, "reason": "Test input"})

    def respond(self, audio, session, seconds, temperature, threshold, emit, cancel, difficulty):
        self.called.set()
        self.audio = audio.copy()
        self.difficulty = difficulty
        assert audio.dtype == np.float32
        note = Note(pitch=60, start=0, duration=0.5, velocity=75).model_dump()
        emit({"type": "heard", "notes": [note]})
        emit({"type": "note", "note": note})
        emit({"type": "done", "notes": 1})


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("piano_duet.server.SAMPLES", tmp_path)
    monkeypatch.setattr("piano_duet.server.NOTATION", tmp_path)
    with TestClient(
        create_app(engine_factory=RecordingEngine, profile_path=tmp_path / "learner.sqlite3")
    ) as result:
        yield result


def test_stream_and_release_busy(client):
    response = client.post(f"/api/respond?session={uuid4()}", content=PCM, headers=HEADERS)
    assert response.status_code == 200
    assert [json.loads(line)["type"] for line in response.text.splitlines()] == [
        "attempt",
        "heard",
        "note",
        "done",
    ]
    assert not client.get("/api/status").json()["busy"]


def test_brand_manifest_and_icons_are_served_from_signed_off_assets(client):
    manifest = client.get("/static/brand/manifest.webmanifest")
    assert manifest.status_code == 200
    assert manifest.json()["start_url"] == "/"
    assert {icon["purpose"] for icon in manifest.json()["icons"]} == {
        "any", "maskable", "monochrome"
    }
    names = ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]
    names += [icon["src"].removeprefix("./") for icon in manifest.json()["icons"]]
    for name in names:
        response = client.get(f"/static/brand/{name}")
        assert response.status_code == 200
        assert response.content == (Path("design/brand/assets") / name).read_bytes()


def test_cross_origin_audio_is_rejected(client):
    response = client.post(
        f"/api/respond?session={uuid4()}",
        content=PCM,
        headers={**HEADERS, "Origin": "https://untrusted.example"},
    )
    assert response.status_code == 403
    assert not client.app.state.engine.called.is_set()


@pytest.mark.parametrize(
    "payload",
    [
        b"a",
        np.full(3200, np.nan, dtype="<f4").tobytes(),
        np.full(3200, np.inf, dtype="<f4").tobytes(),
    ],
)
def test_invalid_audio_rejected_before_inference(client, payload):
    response = client.post(f"/api/respond?session={uuid4()}", content=payload, headers=HEADERS)
    assert response.status_code == 400
    assert not client.app.state.engine.called.is_set()


def test_long_performance_reaches_inference_without_truncation(client):
    audio = np.linspace(-0.2, 0.3, 5 * 60 * 16000, dtype="<f4")
    response = client.post(
        f"/api/respond?session={uuid4()}", content=audio.tobytes(), headers=HEADERS
    )
    assert response.status_code == 200
    np.testing.assert_array_equal(client.app.state.engine.audio, audio)


@pytest.mark.parametrize("level", range(1, 6))
def test_difficulty_is_forwarded_to_the_model(client, level):
    response = client.post(
        f"/api/respond?session={uuid4()}&difficulty={level}", content=PCM, headers=HEADERS
    )
    assert response.status_code == 200
    assert client.app.state.engine.difficulty == level


@pytest.mark.parametrize("level", [0, 6, 1.5])
def test_invalid_difficulty_is_rejected_before_inference(client, level):
    response = client.post(
        f"/api/respond?session={uuid4()}&difficulty={level}", content=PCM, headers=HEADERS
    )
    assert response.status_code == 422
    assert not client.app.state.engine.called.is_set()


def test_hot_microphone_audio_preserves_waveform_instead_of_rejecting(client):
    audio = np.tile(np.array([-2, -1, 0.5, 2], dtype="<f4"), 800)
    response = client.post(
        f"/api/respond?session={uuid4()}", content=audio.tobytes(), headers=HEADERS
    )
    assert response.status_code == 200
    np.testing.assert_array_equal(client.app.state.engine.audio, audio / 2)


def test_normal_audio_keeps_its_original_dynamics(client):
    audio = np.linspace(-0.25, 0.5, 3200, dtype="<f4")
    response = client.post(
        f"/api/respond?session={uuid4()}", content=audio.tobytes(), headers=HEADERS
    )
    assert response.status_code == 200
    np.testing.assert_array_equal(client.app.state.engine.audio, audio)


def test_export_is_valid_midi(client):
    response = client.post(
        "/api/export",
        json={"notes": [{"pitch": 60, "start": 0, "duration": 1, "velocity": 80}]},
        headers={"X-Duet-Client": "1"},
    )
    assert response.status_code == 200
    assert response.content.startswith(b"MThd")


def test_model_errors_are_explicit_and_unlock_engine(client):
    def broken(*args):
        raise RuntimeError("Model failure for test")

    client.app.state.engine.respond = broken
    response = client.post(f"/api/respond?session={uuid4()}", content=PCM, headers=HEADERS)
    assert json.loads(response.text) == {"type": "error", "message": "Model failure for test"}
    assert not client.get("/api/status").json()["busy"]


def test_normal_run_does_not_enable_browser_reload(client):
    assert not client.get("/api/status").json()["development"]
    assert "/static/reload.mjs?revision=" not in client.get("/").text
    assert client.get("/__dev/events").status_code == 404


@pytest.fixture
def development_client(tmp_path, monkeypatch):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html><head></head><body>Piano</body></html>")
    (static / "app.mjs").write_text("export const label = 'Piano';")
    (static / "styles.css").write_text("body { color: black; }")
    monkeypatch.setattr("piano_duet.server.STATIC", static)
    monkeypatch.setattr("piano_duet.server.SAMPLES", tmp_path)
    monkeypatch.setattr("piano_duet.server.NOTATION", tmp_path)
    with TestClient(
        create_app(
            engine_factory=RecordingEngine,
            profile_path=tmp_path / "learner.sqlite3",
            development=True,
        )
    ) as result:
        yield result, static


@pytest.mark.parametrize("filename", ["index.html", "styles.css", "app.mjs"])
def test_development_revision_tracks_frontend_edits(development_client, filename):
    client, static = development_client
    page = client.get("/")
    revision = page.text.split("/static/reload.mjs?revision=")[1].split('"')[0]
    assert page.headers["cache-control"] == "no-store"
    assert client.get("/api/status").json()["development"]
    events = client.get("/__dev/events")
    assert events.headers["content-type"].startswith("text/event-stream")
    assert events.headers["cache-control"] == "no-store"
    assert f"data: {revision}\n" in events.text

    path = static / filename
    path.write_text(path.read_text() + "\nChanged source")
    assert f"data: {revision}\n" not in client.get("/__dev/events").text
    source = client.get(f"/static/{filename}")
    assert source.headers["cache-control"] == "no-store"
    assert source.text.endswith("Changed source")


def test_development_restart_changes_revision(development_client, tmp_path):
    client, _ = development_client
    before = client.get("/__dev/events").text
    with TestClient(
        create_app(
            engine_factory=RecordingEngine,
            profile_path=tmp_path / "restart.sqlite3",
            development=True,
        )
    ) as restarted:
        assert restarted.get("/__dev/events").text != before


if __name__ == "__main__":
    main()
