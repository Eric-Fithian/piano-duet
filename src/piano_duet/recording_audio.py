import subprocess

import numpy as np
from imageio_ffmpeg import get_ffmpeg_exe

from piano_duet.recording_transcription import SAMPLE_RATE
from piano_duet.score_import import ScoreError

MAX_SECONDS = 15 * 60
MAX_BYTES = 100_000_000


def main():
    raise SystemExit("Recording audio is decoded from the app's in-memory import request.")


def decode_recording(data):
    if not data or len(data) > MAX_BYTES:
        raise ScoreError("Choose a recording under 100 MB")
    decoded = subprocess.run(
        [get_ffmpeg_exe(), "-v", "error", "-i", "pipe:0", "-t", str(MAX_SECONDS + 1),
         "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
        input=data, capture_output=True, check=False,
    )
    if decoded.returncode:
        raise ScoreError("The recording could not be decoded")
    audio = np.frombuffer(decoded.stdout, dtype="<f4").copy()
    if not len(audio):
        raise ScoreError("The recording has no audio")
    if len(audio) > MAX_SECONDS * SAMPLE_RATE:
        raise ScoreError("Recordings up to 15 minutes can be transcribed")
    return audio
