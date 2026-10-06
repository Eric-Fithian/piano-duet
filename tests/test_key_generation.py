from threading import Event

import numpy as np
import pytest

from piano_duet.notes import Note
from piano_duet.server import DuetEngine


def main():
    raise SystemExit(pytest.main([__file__]))


class Transcriber:
    def __init__(self):
        self.tonic = 0

    def warmup(self):
        pass

    def transcribe(self, audio, threshold, cancel, on_progress):
        return [
            Note(pitch=60 + self.tonic + step, start=i * 0.4, duration=0.35, velocity=80)
            for i, step in enumerate([0, 4, 7, 5, 9, 11, 2, 0, 0])
        ]


class Generator:
    def __init__(self):
        self.constraints = []
        self.outside = False

    def warmup(self):
        pass

    def generate(self, prompt, seconds, temperature, cancel, pitch_classes, tonic, difficulty):
        self.constraints.append(pitch_classes)
        # A-heavy replies would bias a tracker that accidentally listened to its own output.
        pitch = 66 if self.outside else 60 + pitch_classes[5]
        for i in range(12):
            yield Note(pitch=pitch, start=i * 0.2, duration=0.3, velocity=80)


@pytest.fixture
def engine(monkeypatch):
    monkeypatch.setattr("piano_duet.server.PianoTranscriber", Transcriber)
    monkeypatch.setattr("piano_duet.server.PianoGenerator", Generator)
    return DuetEngine()


def respond(engine, session="first"):
    events = []
    engine.respond(np.zeros(16000), session, 3, 0.95, 0.75, events.append, Event())
    return events


def test_model_replies_do_not_become_key_detection_evidence(engine):
    for _ in range(4):
        events = respond(engine)
        key = events[0]["key"]
        assert key["name"] == "C major"
        assert engine.generator.constraints[-1] == tuple(key["pitch_classes"])
        assert all(
            event["note"]["pitch"] % 12 in key["pitch_classes"]
            for event in events
            if event["type"] == "note"
        )


def test_new_session_starts_its_key_estimate_from_the_current_phrase(engine):
    respond(engine)
    engine.transcriber.tonic = 2
    respond(engine)
    events = respond(engine, "second")
    assert events[0]["key"]["name"] == "D major"
    assert not events[0]["key"]["changed"]


def test_outside_note_cannot_be_streamed_if_model_constraint_breaks(engine):
    engine.generator.outside = True
    events = []
    with pytest.raises(RuntimeError) as error:
        engine.respond(np.zeros(16000), "first", 3, 0.95, 0.75, events.append, Event())
    assert "outside the constrained key" in str(error.value)
    assert not any(event["type"] == "note" for event in events)


if __name__ == "__main__":
    main()
