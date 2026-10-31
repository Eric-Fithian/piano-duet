"""Create a synthetic piano-window reference from the original transcription graph."""

import argparse
from pathlib import Path

import numpy as np

from piano_duet.transcription import PianoTranscriber


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('tests/fixtures/live-transcription.npz'))
    args = parser.parse_args()
    audio = synthetic_audio()
    model = PianoTranscriber()
    outputs = model.session.run(['reg_onset', 'frame', 'velocity'], {model.input_name: audio[None]})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(args.output, reg_onset=outputs[0], frame=outputs[1], velocity=outputs[2])
    print(f'{args.output}: {args.output.stat().st_size} bytes')


def synthetic_audio():
    rate = 16000
    audio = np.zeros(2 * rate, dtype=np.float32)
    for start, frequency in ((0.25, 261.625565), (0.75, 311.126984), (1.25, 369.994423)):
        length = min(rate // 2, len(audio) - round(start * rate))
        time = np.arange(length, dtype=np.float32) / rate
        tone = np.sin(2 * np.pi * frequency * time) * np.exp(-4 * time)
        index = round(start * rate)
        audio[index:index + length] += 0.25 * tone
    return audio


if __name__ == '__main__':
    main()
