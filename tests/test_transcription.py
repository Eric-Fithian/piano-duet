from threading import Event

import numpy as np
import pytest

from piano_duet.transcription import SAMPLE_RATE, PianoTranscriber


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


if __name__ == "__main__":
    main()
