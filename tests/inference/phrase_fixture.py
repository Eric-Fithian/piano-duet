"""Render synthetic piano attacks and transcribe them with the Python reference."""

import json
import os
import subprocess
from pathlib import Path
from time import perf_counter

import imageio_ffmpeg
import numpy as np

from piano_duet import transcription


def main():
    sample = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error',
         '-i', '.cache/browser-inference/C4.mp3', '-ar', '16000', '-ac', '1', '-f', 'f32le', 'pipe:1'],
        capture_output=True, check=True,
    ).stdout
    sound = np.frombuffer(sample, dtype='<f4')[:16000]
    audio = np.zeros(184000, dtype=np.float32)
    for start, scale in ((0.3, 1), (1.3, .7), (4.7, .8), (5.2, .6), (7.5, .9), (10.2, .8)):
        begin = round(start * 16000)
        audio[begin:begin + len(sound)] += sound * scale
    path = Path('.cache/browser-inference/phrase.pcm')
    path.write_bytes(audio.astype('<f4').tobytes())
    transcription.TRANSCRIPTION = Path(os.environ.get('PIANO_PHRASE_MODEL', '.cache/models/transcription/piano_crnn.onnx'))
    engine = transcription.PianoTranscriber()
    started = perf_counter()
    notes = engine.transcribe(audio)
    elapsed = perf_counter() - started
    if len(notes) < 4:
        raise RuntimeError(f'The synthetic phrase produced too few notes: {len(notes)}')
    result = {'notes': [note.model_dump() for note in notes], 'quality': engine.last_quality, 'elapsedMs': elapsed * 1000}
    Path('.cache/browser-inference/phrase-reference.json').write_text(json.dumps(result) + '\n')
    print(json.dumps({'notes': len(notes), 'elapsedMs': elapsed * 1000}))


if __name__ == '__main__':
    main()
