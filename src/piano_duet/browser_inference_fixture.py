"""Prepare local model inputs and Python reference outputs for browser measurements."""

import json
import time
from pathlib import Path

import numpy as np
import onnx
import soundfile as sf
from scipy.signal import resample_poly

from piano_duet.assets import SAMPLES, TRANSCRIPTION
from piano_duet.transcription import LIVE_WINDOW, SAMPLE_RATE, PianoTranscriber

DIRECTORY = Path(".cache/browser-inference")


def main():
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    model = onnx.load(str(TRANSCRIPTION))
    dimension = model.graph.input[0].type.tensor_type.shape.dim[1]
    if dimension.dim_value != SAMPLE_RATE * 10:
        raise ValueError("Unexpected transcription model window")
    dimension.ClearField("dim_value")
    dimension.dim_param = "samples"
    model = onnx.utils.Extractor(model).extract_model(
        [model.graph.input[0].name], ["reg_onset", "frame", "velocity"]
    )
    onnx.save(model, str(DIRECTORY / "transcription.onnx"))
    inferred = onnx.shape_inference.infer_shapes(model)
    producers = {output: node for node in inferred.graph.node for output in node.output}
    initializers = {item.name for item in inferred.graph.initializer}
    recurrent_values = set()
    for node in inferred.graph.node:
        if node.op_type == "GRU" or any(name in recurrent_values for name in node.input):
            recurrent_values.update(node.output)
    boundaries = sorted({name for node in inferred.graph.node
                         if any(output in recurrent_values for output in node.output)
                         for name in node.input if name and name not in recurrent_values
                         and name not in initializers and name in producers
                         and producers[name].op_type != "Constant"})
    if len(boundaries) != 12:
        raise ValueError(f"Unexpected transcription GRU boundaries: {boundaries}")
    convolution = onnx.utils.Extractor(inferred).extract_model([inferred.graph.input[0].name], boundaries)
    recurrent = onnx.utils.Extractor(inferred).extract_model(boundaries, ["reg_onset", "frame", "velocity"])
    onnx.checker.check_model(convolution)
    onnx.checker.check_model(recurrent)
    onnx.save(convolution, str(DIRECTORY / "transcription-convolution-fp32.onnx"))
    onnx.save(recurrent, str(DIRECTORY / "transcription-recurrent.onnx"))
    audio = np.zeros(LIVE_WINDOW, dtype=np.float32)
    for name, seconds in (("C4.mp3", 0.3), ("Ds4.mp3", 0.8), ("Fs4.mp3", 1.3)):
        sample, rate = sf.read(SAMPLES / name, dtype="float32")
        if sample.ndim != 1:
            raise ValueError(f"Expected mono sample: {name}")
        sample = resample_poly(sample, SAMPLE_RATE, rate).astype(np.float32)
        start = round(seconds * SAMPLE_RATE)
        length = min(len(sample), LIVE_WINDOW - start)
        audio[start : start + length] += sample[:length] * 0.3
    fake_microphone = np.zeros(SAMPLE_RATE * 12, dtype=np.float32)
    note, rate = sf.read(SAMPLES / "C4.mp3", dtype="float32")
    if note.ndim != 1:
        raise ValueError("Expected a mono C4 sample")
    note = resample_poly(note, SAMPLE_RATE, rate).astype(np.float32)
    for seconds in (2, 4, 6, 8):
        start = seconds * SAMPLE_RATE
        length = min(SAMPLE_RATE, len(note))
        fake_microphone[start : start + length] += note[:length] * 0.5
    sf.write(DIRECTORY / "microphone-c4.wav", fake_microphone, SAMPLE_RATE, subtype="PCM_16")
    transcriber = PianoTranscriber()
    durations = []
    for _ in range(6):
        started = time.perf_counter()
        outputs = transcriber.session.run(["reg_onset", "frame", "velocity"],
                                          {transcriber.input_name: audio[None]})
        durations.append((time.perf_counter() - started) * 1000)
    fixture = {"audio": audio.tolist(), "onset": outputs[0].reshape(-1).tolist(),
               "onset_shape": list(outputs[0].shape), "notes": transcriber.listen(audio),
               "python_run_ms": durations}
    (DIRECTORY / "transcription.json").write_text(json.dumps(fixture) + "\n")
    print(json.dumps({"notes": len(fixture["notes"]), "python_run_ms": durations}))


if __name__ == "__main__":
    main()
