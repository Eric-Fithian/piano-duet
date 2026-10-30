"""Capture the actual masked choices and inference workload for Reading and Duet."""

import inspect
import json
import random
import sys
from pathlib import Path

import mlx.core as mx
import numpy as np

from piano_duet.generation import ConstrainedPhrase, PianoGenerator
from piano_duet.notes import Note
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_music import compose_reading
from piano_duet.reading_stages import STAGES

OUTPUT = Path(".cache/models/aria/onnx-int4-block64/sampling.json")


def main():
    mx.random.seed(14)
    generator = PianoGenerator()
    tracker = TrackedModel(generator.model)
    generator.model = tracker
    reading_line = score_line(ConstrainedPhrase.choose, "scores = logits[")
    duet_line = score_line(PianoGenerator.sample_notes, "scores = logits[")
    cases = []
    workloads = []
    for stage in (STAGES[0], STAGES[5], STAGES[11], STAGES[17], STAGES[23]):
        progress = reading_progress([])
        progress["curriculum"].update(target=stage["id"], target_number=stage["number"])
        label = f"reading:{stage['id']}"
        tracker.reset_counts()
        captured = capture(lambda progress=progress: compose_reading(progress, random.Random(14), generator.phrase),
                           tracker, reading_line, duet_line)
        cases.extend(sample_cases(label, captured))
        workloads.append({"context": label, "choices": len(captured), **tracker.counts()})
    notes = [Note(pitch=pitch, start=index * 0.5, duration=0.4, velocity=80)
             for index, pitch in enumerate((60, 64, 67, 72))]
    tracker.reset_counts()
    captured = capture(lambda: list(generator.generate(notes, seconds=5)), tracker, reading_line, duet_line)
    cases.extend(sample_cases("duet", captured))
    workloads.append({"context": "duet", "choices": len(captured), **tracker.counts()})
    OUTPUT.write_text(json.dumps({"cases": cases, "workloads": workloads}) + "\n")
    print(json.dumps(workloads, indent=2))


class TrackedModel:
    def __init__(self, model):
        self.model = model
        self.history = []
        self.calls = []

    def setup_cache(self, *args, **kwargs):
        self.history = []
        return self.model.setup_cache(*args, **kwargs)

    def __call__(self, tokens, positions, **kwargs):
        values = tokens.tolist()[0]
        offset = int(positions.tolist()[0])
        self.history = self.history[:offset] + values
        self.calls.append(len(values))
        return self.model(tokens, positions, **kwargs)

    def reset_counts(self):
        self.calls = []

    def counts(self):
        return {"model_calls": len(self.calls), "model_input_tokens": sum(self.calls),
                "call_sizes": self.calls}


def score_line(function, prefix):
    lines, first = inspect.getsourcelines(function)
    return first + next(index for index, line in enumerate(lines) if line.strip().startswith(prefix))


def capture(function, tracker, reading_line, duet_line):
    captured = []
    seen_reading_calls = set()

    def trace(frame, event, arg):
        if event == "call":
            if frame.f_code in (ConstrainedPhrase.choose.__code__, PianoGenerator.sample_notes.__code__):
                return trace
            return None
        if event == "line" and frame.f_lineno in (reading_line, duet_line):
            if frame.f_lineno == reading_line:
                if frame in seen_reading_calls:
                    return trace
                seen_reading_calls.add(frame)
            values = frame.f_locals
            options = values["options"] if frame.f_lineno == reading_line else dict.fromkeys(values["allowed"], 1.0)
            logits = np.asarray(values["logits"].astype(mx.float32))
            captured.append({"tokens": list(tracker.history), "allowed": list(options),
                             "weights": list(options.values()), "mlx_logits": logits.tolist()})
        return trace

    sys.settrace(trace)
    function()
    sys.settrace(None)
    return captured


def sample_cases(label, captured):
    if len(captured) < 10:
        raise ValueError(f"Fewer than ten sampled choices for {label}")
    indices = [round(index * (len(captured) - 1) / 9) for index in range(10)]
    return [{"context": label, **captured[index]} for index in indices]


if __name__ == "__main__":
    main()
