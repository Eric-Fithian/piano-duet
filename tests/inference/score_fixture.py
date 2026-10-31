"""Record public score-model inputs and greedy output for local browser parity."""

import argparse
import json
import runpy
import sys
import time
from pathlib import Path

import torch

ROOT = Path('.cache/m2st')
sys.path.insert(0, str(ROOT / 'repo/midi2scoretransformer'))
from models.roformer import Roformer
from tokenizer import MultistreamTokenizer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('midi', type=Path)
    parser.add_argument('--checkpoint', type=Path, default=ROOT / 'MIDI2ScoreTF.ckpt')
    parser.add_argument('--output', type=Path, default=ROOT / 'score-fixture.json')
    args = parser.parse_args()
    torch.set_num_threads(4)
    model = Roformer.load_from_checkpoint(str(args.checkpoint), map_location='cpu').eval()
    source = MultistreamTokenizer.tokenize_midi(str(args.midi))
    streams = {name: value.unsqueeze(0) for name, value in source.items()}
    infer = runpy.run_path('src/piano_duet/midi_to_score.py')['infer']
    started = time.perf_counter()
    with torch.inference_mode():
        result = infer(model, source, 'cpu')
    expected = {name: (value[:, 0].long() if name == 'pad' else value.argmax(-1)).tolist()
                for name, value in result.items()}
    fixture = {'source': {name: value.tolist() for name, value in streams.items()}, 'expected': expected,
               'reference_ms': 1000 * (time.perf_counter() - started), 'source_notes': streams['pitch'].shape[1]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fixture))
    print(f'{fixture["source_notes"]} input notes, {sum(expected["pad"])} output notes, {fixture["reference_ms"]:.0f} ms')


if __name__ == '__main__':
    main()
