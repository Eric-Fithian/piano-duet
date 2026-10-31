"""Create synthetic audio files and native-decoder references for browser parity."""

import json
import subprocess
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

DIRECTORY = Path('.cache/audio-formats')
FORMATS = (('mp3', 'libmp3lame', 44100), ('m4a', 'aac', 48000), ('flac', 'flac', 48000), ('webm', 'libopus', 48000))


def main():
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    rate = 44100
    times = np.arange(rate * 3, dtype=np.float32) / rate
    envelope = np.exp(-times * 1.5) * (1 + 0.15 * np.sin(2 * np.pi * 2 * times))
    left = envelope * (0.3 * np.sin(2 * np.pi * 261.63 * times) + 0.08 * np.sin(2 * np.pi * 523.26 * times))
    right = envelope * (0.25 * np.sin(2 * np.pi * 329.63 * times) + 0.06 * np.sin(2 * np.pi * 659.26 * times))
    sf.write(DIRECTORY / 'source.wav', np.stack((left, right), axis=-1), rate, subtype='FLOAT')
    binary = imageio_ffmpeg.get_ffmpeg_exe()
    for extension, codec, native_rate in FORMATS:
        path = DIRECTORY / f'fixture.{extension}'
        subprocess.run([binary, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(DIRECTORY / 'source.wav'),
                        '-ar', str(native_rate), '-c:a', codec, str(path)], check=True)
        output = subprocess.run([binary, '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', str(path),
                                 '-ac', '1', '-f', 'f32le', 'pipe:1'], check=True, capture_output=True).stdout
        reference = resample_poly(np.frombuffer(output, dtype='<f4'), rate, native_rate).astype('<f4')
        (DIRECTORY / f'fixture.{extension}.pcm').write_bytes(reference.tobytes())
    (DIRECTORY / 'manifest.json').write_text(json.dumps({'formats': [name for name, _, _ in FORMATS]}) + '\n')


if __name__ == '__main__':
    main()
