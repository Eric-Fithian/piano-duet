import argparse
import time
from collections.abc import Callable
from threading import Event

import numpy as np
import onnxruntime as ort
import soundfile as sf
from piano_transcription_inference.utilities import RegressionPostProcessor
from scipy.signal import resample_poly
from tqdm import tqdm

from piano_duet.assets import TRANSCRIPTION
from piano_duet.notes import Note

SAMPLE_RATE = 16000
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
        self.session = ort.InferenceSession(
            str(TRANSCRIPTION), sess_options=options, providers=["CPUExecutionProvider"]
        )
        inputs = self.session.get_inputs()
        if len(inputs) != 1 or inputs[0].shape != [1, 160000]:
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

    def transcribe(
        self,
        audio: np.ndarray,
        onset_threshold: float = 0.75,
        cancel: Event | None = None,
        on_progress: Callable[[float], None] | None = None,
    ) -> list[Note]:
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
        audio_seconds = len(audio) / SAMPLE_RATE
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
        return sorted(notes, key=lambda note: (note.start, note.pitch))


if __name__ == "__main__":
    main()
