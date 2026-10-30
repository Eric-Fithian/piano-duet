"""Converts a performance MIDI file to MusicXML with MIDI2ScoreTransformer (Beyer & Dai, ISMIR 2024).

Runs inside the isolated environment at .cache/m2st/venv, not the app's environment:
    .cache/m2st/venv/bin/python -I src/piano_duet/midi_to_score.py performance.mid score.musicxml
(-I keeps this folder, whose profile.py would shadow the standard library, off sys.path.)
"""

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(".cache/m2st")
sys.path.insert(0, str(ROOT / "repo/midi2scoretransformer"))

import torch
from models.roformer import Roformer
from score_utils import postprocess_score
from tokenizer import MultistreamTokenizer

CHUNK = 512
OVERLAP = 64
# Accidental classes in MultistreamTokenizer: the pitch's alteration, from double-flat (0) up, or 5 for none.
FLAT, SHARP = 1, 3


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("midi", type=Path)
    parser.add_argument("musicxml", type=Path)
    parser.add_argument("--device", choices=["mps", "cpu"], default="mps" if torch.backends.mps.is_available() else "cpu")
    parser.add_argument("--checkpoint", type=Path, required=True)
    args = parser.parse_args()
    started = time.perf_counter()
    model = Roformer.load_from_checkpoint(args.checkpoint, map_location="cpu").to(args.device).eval()
    loaded = time.perf_counter()
    convert(model, args.midi, args.musicxml, args.device)
    print(f"loaded {loaded - started:.1f}s, converted {time.perf_counter() - loaded:.1f}s on {args.device}", file=sys.stderr)


@torch.inference_mode()
def infer(model, tokens, device):
    """Chunked greedy decoding; each chunk after the first sees the previous chunk's last notes."""
    x = {key: value.unsqueeze(0).to(device) for key, value in tokens.items()}
    length = x["pitch"].shape[1]
    output = None
    for start in range(0, max(length - OVERLAP, 1), CHUNK - OVERLAP):
        window = {key: value[:, start : start + CHUNK] for key, value in x.items()}
        if output is None:
            output = model.generate(x=window, top_k=1, max_length=CHUNK, kv_cache=True)
            continue
        context = {key: value[:, -OVERLAP:] if key != "pad" else value[:, -OVERLAP:, 0] for key, value in output.items()}
        generated = model.generate(x=window, y=context, top_k=1, max_length=CHUNK, kv_cache=True)
        output = {key: torch.cat((output[key], generated[key][:, OVERLAP:]), dim=1) for key in output}
    return {key: value[0].cpu() for key, value in output.items()}


def match_key_to_spelling(output):
    """The key head treats enharmonic keys 12 fifths apart as one (G# minor and Ab minor) while the accidental head
    commits to sharps or flats, so a piece spelled in sharps can come out under seven flats. Takes the twin key that
    agrees with the spelling."""
    mask = output["pad"].squeeze(-1) > 0.5
    spelled = output["accidental"][mask][:, :6].argmax(-1)
    sign = 1 if (spelled == SHARP).sum() > (spelled == FLAT).sum() else -1
    fifths = output["keysignature"].argmax(-1) - 7
    twin = fifths + 12 * sign
    fixed = torch.where((torch.sign(fifths) == -sign) & (twin.abs() <= 7), twin, fifths)
    keys = torch.nn.functional.one_hot(fixed + 7, output["keysignature"].shape[-1]).to(output["keysignature"].dtype)
    return {**output, "keysignature": torch.where(mask[:, None], keys, output["keysignature"])}


def convert(model, midi, musicxml, device):
    output = match_key_to_spelling(infer(model, MultistreamTokenizer.tokenize_midi(str(midi)), device))
    score = MultistreamTokenizer.detokenize_mxl(output)
    postprocess_score(score, inPlace=True).write("musicxml", fp=str(musicxml), makeNotation=False)


if __name__ == "__main__":
    main()
