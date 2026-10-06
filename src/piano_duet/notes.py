from io import BytesIO

from ariautils.midi import MidiDict
from pydantic import BaseModel, Field


def main():
    print("Notes are represented as MIDI pitch, onset seconds, duration seconds, and velocity.")


class Note(BaseModel):
    pitch: int = Field(ge=21, le=108)
    start: float = Field(ge=0, allow_inf_nan=False)
    duration: float = Field(gt=0, allow_inf_nan=False)
    velocity: int = Field(ge=1, le=127)


def to_midi_dict(notes: list[Note]) -> MidiDict:
    return MidiDict(
        meta_msgs=[],
        tempo_msgs=[{"type": "tempo", "data": 500000, "tick": 0}],
        pedal_msgs=[],
        instrument_msgs=[{"type": "instrument", "data": 0, "tick": 0, "channel": 0}],
        note_msgs=[
            {
                "type": "note",
                "channel": 0,
                "tick": round(note.start * 1000),
                "data": {
                    "pitch": note.pitch,
                    "start": round(note.start * 1000),
                    "end": round((note.start + note.duration) * 1000),
                    "velocity": note.velocity,
                },
            }
            for note in sorted(notes, key=lambda n: (n.start, n.pitch))
        ],
        ticks_per_beat=500,
        metadata={},
    )


def midi_bytes(notes: list[Note]) -> bytes:
    if not notes:
        raise ValueError("Cannot export an empty performance")
    output = BytesIO()
    to_midi_dict(notes).to_midi().save(file=output)
    return output.getvalue()


def from_midi(path) -> list[Note]:
    midi = MidiDict.from_midi(path)
    return [
        Note(
            pitch=msg["data"]["pitch"],
            start=midi.tick_to_ms(msg["data"]["start"]) / 1000,
            duration=max(
                0.01,
                (midi.tick_to_ms(msg["data"]["end"]) - midi.tick_to_ms(msg["data"]["start"]))
                / 1000,
            ),
            velocity=msg["data"]["velocity"],
        )
        for msg in midi.note_msgs
        if 21 <= msg["data"]["pitch"] <= 108
    ]
