import json
import random
from pathlib import Path

import mlx.core as mx
from ariautils.tokenizer import AbsTokenizer

from piano_duet.generation import PianoGenerator
from piano_duet.notes import Note
from piano_duet.phrasing import PhraseEnding, estimate_beat


def main():
    tokenizer = AbsTokenizer()
    cases = []
    for level, seconds, tonic in ((1, 2, 0), (3, 5, 9), (5, 8, 5)):
        notes = [
            Note(pitch=pitch, start=start, duration=duration, velocity=velocity)
            for pitch, start, duration, velocity in (
                (60, 0, 0.4, 80),
                (64, 0.5, 0.5, 90),
                (67, 4.9, 0.3, 70),
                (72, 5.4, 0.8, 80),
            )
        ]
        scale = [(tonic + interval) % 12 for interval in (0, 2, 4, 5, 7, 9, 11)]
        model = TraceModel(tokenizer)
        generator = make_generator(tokenizer, model)
        chooser = TraceChooser(level)
        mx.random.categorical = chooser.choose
        ending = PhraseEnding(seconds, estimate_beat(notes), tonic, scale)
        sampled = list(generator.sample_notes(notes, ending, 1.0, None, 28, None, scale, level))
        cases.append(
            {
                "level": level,
                "seconds": seconds,
                "tonic": tonic,
                "scale": scale,
                "prompt": [note.model_dump() for note in notes],
                "promptTokens": model.prefill,
                "choices": chooser.choices,
                "notes": [note.model_dump() if note is not None else None for note in sampled],
            }
        )
    Path("tests/fixtures/duet-sampling.json").write_text(json.dumps(cases, separators=(",", ":")) + "\n")


class TraceModel:
    def __init__(self, tokenizer):
        self.logits = mx.arange(tokenizer.vocab_size, dtype=mx.float32) / 100000
        self.prefill = None

    def setup_cache(self, *args, **kwargs):
        pass

    def __call__(self, tokens, *args, **kwargs):
        if self.prefill is None:
            self.prefill = tokens[0].tolist()
        return self.logits[None, None, :]


class TraceChooser:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.choices = []
        self.notes = 0

    def choose(self, scores):
        options = [round(float(score) * 100000) for score in scores.tolist()]
        if len(options) == 1:
            selected = options[0]
        elif options[0] >= 17227:
            selected = self.rng.choice(options[: min(12, len(options))])
        elif options[0] >= 16727:
            selected = min(options, key=lambda token: abs(token - (16726 + 30)))
            self.notes += 1
        elif self.notes >= 20 and 1 in options:
            selected = 1
        else:
            pitches = [token for token in options if token >= 313]
            selected = self.rng.choice(pitches) if pitches else 5
        self.choices.append({"options": ranges(options), "selected": selected})
        return mx.array(options.index(selected))


def ranges(options):
    result = []
    for option in options:
        if result and option == result[-1][1] + 1:
            result[-1][1] = option
        else:
            result.append([option, option])
    return result


def make_generator(tokenizer, model):
    generator = object.__new__(PianoGenerator)
    generator.tokenizer = tokenizer
    generator.model = model
    generator.note_ids = [
        index
        for index, token in tokenizer.id_to_tok.items()
        if isinstance(token, tuple) and token[0] == "piano" and 21 <= token[1] <= 108 and token[2] > 0
    ]
    generator.onset_ids = [tokenizer.tok_to_id[token] for token in tokenizer.onset_tokens]
    generator.duration_ids = [tokenizer.tok_to_id[token] for token in tokenizer.dur_tokens if token[1] > 0]
    generator.time_id = tokenizer.tok_to_id[tokenizer.time_tok]
    generator.end_id = tokenizer.tok_to_id[tokenizer.eos_tok]
    generator.dim_id = tokenizer.tok_to_id[tokenizer.dim_tok]
    return generator


if __name__ == "__main__":
    main()
