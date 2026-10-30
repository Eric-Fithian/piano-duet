from threading import Event

import numpy as np
import pytest

from piano_duet.transcription import LIVE_WINDOW, SAMPLE_RATE, PianoTranscriber


def main():
    raise SystemExit(pytest.main([__file__]))


class SilenceSession:
    def __init__(self):
        self.calls = 0

    def run(self, names, inputs):
        self.calls += 1
        return [np.zeros((1, 1001, classes), dtype=np.float32) for classes in [88] * 4 + [1] * 3]


@pytest.fixture
def transcriber():
    result = PianoTranscriber.__new__(PianoTranscriber)
    result.session = SilenceSession()
    result.input_name = "audio"
    return result


def test_long_audio_is_fully_processed_with_progress(transcriber):
    progress = []
    notes = transcriber.transcribe(np.zeros(70 * SAMPLE_RATE), on_progress=progress.append)
    assert notes == []
    assert transcriber.session.calls == 14
    assert progress == sorted(progress)
    assert progress[-1] == 1


def test_stop_cancels_long_transcription_after_current_window(transcriber):
    cancel = Event()
    notes = transcriber.transcribe(
        np.zeros(300 * SAMPLE_RATE), cancel=cancel, on_progress=lambda progress: cancel.set()
    )
    assert notes == []
    assert transcriber.session.calls == 1


def test_cancelled_transcription_does_not_run_model(transcriber):
    cancel = Event()
    cancel.set()
    assert transcriber.transcribe(np.zeros(SAMPLE_RATE), cancel=cancel) == []
    assert transcriber.session.calls == 0


class AttackSession:
    def run(self, names, inputs):
        outputs = [np.zeros((1, 201, classes), dtype=np.float32) for classes in [88] * 4 + [1] * 3]
        for pitch, confidence, supported in [(60, 0.79, True), (64, 0.88, True), (67, 0.95, False)]:
            column = pitch - 21
            outputs[0][0, 48:53, column] = np.array([0.2, 0.6, 1, 0.6, 0.2]) * confidence
            outputs[3][0, :, column] = 0.6
            if supported:
                outputs[2][0, 50:80, column] = 0.8
        return [outputs[index] for index in (0, 2, 3)]


def test_live_confidence_rejects_weak_attacks_without_using_the_expected_score(transcriber):
    transcriber.session = AttackSession()
    audio = np.zeros(LIVE_WINDOW, dtype=np.float32)
    assert [note["pitch"] for note in transcriber.listen(audio, 0.75)] == [60, 64]
    assert [note["pitch"] for note in transcriber.listen(audio, 0.8)] == [64]
    assert transcriber.listen(audio, 0.9) == []


if __name__ == "__main__":
    main()
