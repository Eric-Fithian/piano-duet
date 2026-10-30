"""Compare four-bit ONNX Aria logits with the application's MLX model."""

import json
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
import onnxruntime as ort

from piano_duet.aria_quantize_onnx import QUANTIZED
from piano_duet.generation import PianoGenerator
from piano_duet.notes import Note, to_midi_dict

FIXTURE = Path(".cache/models/aria/onnx-int4-block64/parity.json")


def main():
    generator = PianoGenerator()
    notes = [Note(pitch=pitch, start=index * 0.5, duration=0.4, velocity=80)
             for index, pitch in enumerate((60, 64, 67, 72))]
    tokens = generator.tokenizer.encode(generator.tokenizer.tokenize(
        to_midi_dict(notes), add_dim_tok=False, add_eos_tok=False
    ))
    model = generator.model
    model.setup_cache(1, max_seq_len=len(tokens) + 16, dtype=mx.float16)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(QUANTIZED), sess_options=options, providers=["CPUExecutionProvider"])
    names = [item.name for item in session.get_inputs()]
    cache = [np.zeros((1, 24, 0, 64), dtype=np.float32) for _ in range(32)]
    steps = []
    position = 0
    current = tokens
    for _ in range(9):
        started = time.perf_counter()
        reference = model(mx.array([current]), mx.arange(position, position + len(current)),
                          offset=position, max_kv_pos=position + len(current) - 1)
        mx.eval(reference)
        reference = np.asarray(reference[0, -1].astype(mx.float32))
        mlx_seconds = time.perf_counter() - started
        started = time.perf_counter()
        result = session.run(None, dict(zip(names, [np.array([current], dtype=np.int64), *cache], strict=True)))
        onnx_seconds = time.perf_counter() - started
        cache = result[1:]
        actual = result[0][0, -1]
        difference = actual - reference
        cosine = np.dot(actual, reference) / (np.linalg.norm(actual) * np.linalg.norm(reference))
        steps.append({"tokens": current, "mlx_logits": reference.tolist(),
                      "max_absolute_error": float(np.max(np.abs(difference))),
                      "rmse": float(np.sqrt(np.mean(difference**2))), "cosine": float(cosine),
                      "mlx_top_token": int(np.argmax(reference)), "onnx_top_token": int(np.argmax(actual)),
                      "mlx_seconds": mlx_seconds, "onnx_seconds": onnx_seconds})
        position += len(current)
        current = [int(np.argmax(reference))]
    FIXTURE.write_text(json.dumps({"steps": steps}) + "\n")
    print(json.dumps([{key: value for key, value in step.items() if key not in ("tokens", "mlx_logits")}
                      for step in steps], indent=2))


if __name__ == "__main__":
    main()
