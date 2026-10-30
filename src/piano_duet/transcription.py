import argparse
import time
from collections.abc import Callable
from threading import Event

import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
from piano_transcription_inference.utilities import RegressionPostProcessor
from scipy.signal import resample_poly
from tqdm import tqdm

from piano_duet.assets import TRANSCRIPTION
from piano_duet.notes import Note

SAMPLE_RATE = 16000
NOTE_THRESHOLD = 0.80
LIVE_WINDOW = SAMPLE_RATE * 2
LIVE_LOOKAHEAD = 0.15
WINDOW = SAMPLE_RATE * 10
HOP = SAMPLE_RATE * 5
OUTPUT_NAMES = (
    "reg_onset_output",
    "reg_offset_output",
    "frame_output",
    "velocity_output",
    "reg_pedal_onset_output",
    "reg_pedal_offset_output",
    "pedal_frame_output",
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    args = parser.parse_args()
    audio, rate = sf.read(args.audio, dtype="float32")
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    audio = resample_poly(audio, SAMPLE_RATE, rate).astype(np.float32)
    transcriber = PianoTranscriber()
    started = time.perf_counter()
    notes = transcriber.transcribe(audio)
    print(f"{len(notes)} notes in {time.perf_counter() - started:.3f}s")
    for note in notes:
        print(note.model_dump_json())


class PianoTranscriber:
    def __init__(self):
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        model = onnx.load(str(TRANSCRIPTION))
        dimension = model.graph.input[0].type.tensor_type.shape.dim[1]
        if dimension.dim_value != WINDOW:
            raise ValueError("Unexpected transcription model window")
        # The graph already supports variable time; only its exported input metadata is fixed.
        dimension.ClearField("dim_value")
        dimension.dim_param = "samples"
        self.session = ort.InferenceSession(
            model.SerializeToString(), sess_options=options, providers=["CPUExecutionProvider"]
        )
        inputs = self.session.get_inputs()
        if len(inputs) != 1 or inputs[0].shape != [1, "samples"]:
            raise ValueError(f"Unexpected transcription model inputs: {inputs}")
        self.input_name = inputs[0].name
        self.output_names = [output.name for output in self.session.get_outputs()]
        if self.output_names != [
            "reg_onset",
            "reg_offset",
            "frame",
            "velocity",
            "pedal_onset",
            "pedal_offset",
            "pedal_frame",
        ]:
            raise ValueError(f"Unexpected transcription outputs: {self.output_names}")

    def warmup(self):
        self.session.run(None, {self.input_name: np.zeros((1, WINDOW), dtype=np.float32)})

    def listen(self, audio, onset_threshold=NOTE_THRESHOLD):
        if audio.shape != (LIVE_WINDOW,) or not np.isfinite(audio).all():
            raise ValueError("Live reading expects two seconds of finite mono 16 kHz PCM")
        outputs = self.session.run(
            ["reg_onset", "frame", "velocity"], {self.input_name: audio[None].astype(np.float32)}
        )
        onset, frame, velocity = [output[0] for output in outputs]
        processor = RegressionPostProcessor(100, 88, onset_threshold, 0.3, 0.1, 0.2)
        attacks, shifts = processor.get_binarized_output_from_regression(
            onset, onset_threshold, neighbour=2
        )
        notes = []
        for time_index, pitch_index in np.argwhere(attacks):
            start = (time_index + shifts[time_index, pitch_index]) / 100
            if not 0.25 <= start <= len(audio) / SAMPLE_RATE - LIVE_LOOKAHEAD:
                continue
            # Require sustained pitch evidence as well as an onset, rejecting unsupported spikes.
            sustain = frame[time_index : time_index + 6, pitch_index]
            if np.count_nonzero(sustain >= 0.3) < 3:
                continue
            notes.append(
                {
                    "pitch": int(pitch_index + 21),
                    "start": round(float(start), 4),
                    "velocity": max(
                        1, min(127, round(float(velocity[time_index, pitch_index]) * 128))
                    ),
                    "confidence": round(float(onset[time_index, pitch_index]), 4),
                }
            )
        return notes

    def transcribe(
        self,
        audio: np.ndarray,
        onset_threshold: float = NOTE_THRESHOLD,
        cancel: Event | None = None,
        on_progress: Callable[[float], None] | None = None,
    ) -> list[Note]:
        self.last_quality = {
            "usable": False,
            "onset_support": None,
            "supported_fraction": 0,
            "note_support": [],
            "reason": "No recognized notes",
        }
        if audio.ndim != 1 or not np.isfinite(audio).all():
            raise ValueError("Expected finite mono 16 kHz PCM")
        if len(audio) < SAMPLE_RATE // 10:
            return []
        # Context on both sides keeps attacks at chunk boundaries away from model edges.
        padded = np.pad(audio, (SAMPLE_RATE // 4, SAMPLE_RATE // 4))
        chunks = []
        for start in tqdm(
            range(0, max(1, len(padded) - HOP), HOP), desc="Transcribing piano", leave=False
        ):
            if cancel is not None and cancel.is_set():
                return []
            chunk = padded[start : start + WINDOW]
            chunk = np.pad(chunk, (0, WINDOW - len(chunk)))
            outputs = self.session.run(None, {self.input_name: chunk[None].astype(np.float32)})
            # Each window emits 1001 frames; shared centers are retained once.
            left = 0 if start == 0 else 250
            right = 1000 if start + WINDOW >= len(padded) else 750
            chunks.append([output[0, left:right] for output in outputs])
            if on_progress:
                on_progress(min(1, (start + right * SAMPLE_RATE / 100) / len(padded)))
        if cancel is not None and cancel.is_set():
            return []
        frames = min(
            round(len(padded) / SAMPLE_RATE * 100), sum(chunk[0].shape[0] for chunk in chunks)
        )
        prediction = {
            name: np.concatenate([chunk[i] for chunk in chunks])[:frames]
            for i, name in enumerate(OUTPUT_NAMES)
        }
        audio_seconds = len(audio) / SAMPLE_RATE
        notes, support = decode(prediction, onset_threshold, frames, audio_seconds)
        if support:
            ordered = sorted(
                zip(notes, support, strict=True), key=lambda pair: (pair[0].start, pair[0].pitch)
            )
            notes = [pair[0] for pair in ordered]
            support = [pair[1] for pair in ordered]
            average = float(np.mean(support))
            fraction = sum(value >= 0.6 for value in support) / len(support)
            self.last_quality = {
                "usable": average >= 0.75 and fraction >= 0.8,
                "onset_support": round(average, 3),
                "supported_fraction": round(fraction, 3),
                "note_support": [round(value, 3) for value in support],
                "reason": "Onset model support; not a calibrated probability of correct transcription",
            }
        return sorted(notes, key=lambda note: (note.start, note.pitch))


def decode(prediction, onset_threshold, frames, audio_seconds):
    processor = RegressionPostProcessor(
        frames_per_second=100,
        classes_num=88,
        onset_threshold=onset_threshold,
        offset_threshold=0.3,
        frame_threshold=0.1,
        pedal_offset_threshold=0.2,
    )
    detected, pedals = processor.output_dict_to_midi_events(prediction)
    notes = []
    support = []
    for event in detected:
        start = max(0, event["onset_time"] - 0.25)
        end = event["offset_time"]
        for pedal in pedals or []:
            if pedal["onset_time"] < end < pedal["offset_time"]:
                end = pedal["offset_time"]
                break
        end = min(audio_seconds, end - 0.25)
        if end - start >= 0.055 and start < audio_seconds:
            notes.append(
                Note(
                    pitch=event["midi_note"],
                    start=start,
                    duration=end - start,
                    velocity=max(1, event["velocity"]),
                )
            )
            frame = round(event["onset_time"] * 100)
            strength = float(
                prediction["reg_onset_output"][
                    max(0, frame - 3) : min(frames, frame + 4), event["midi_note"] - 21
                ].max()
            )
            support.append(strength)
    return notes, support


if __name__ == "__main__":
    main()
