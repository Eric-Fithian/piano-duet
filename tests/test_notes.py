from io import BytesIO

import mido
import pytest
from ariautils.tokenizer import AbsTokenizer

from piano_duet.notes import Note, midi_bytes, to_midi_dict


def main():
    raise SystemExit(pytest.main([__file__]))


def test_chords_keep_simultaneous_onsets_and_durations():
    notes = [Note(pitch=p, start=0.125, duration=0.7, velocity=82) for p in (48, 60, 64, 67)]
    midi = mido.MidiFile(file=BytesIO(midi_bytes(notes)))
    clock = 0
    onsets, offsets = {}, {}
    for msg in midi:
        clock += msg.time
        if msg.type == "note_on" and msg.velocity:
            onsets[msg.note] = clock
        elif msg.type == "note_off" or (msg.type == "note_on" and not msg.velocity):
            offsets[msg.note] = clock
    assert set(onsets) == {48, 60, 64, 67}
    assert all(start == pytest.approx(0.125) for start in onsets.values())
    assert all(end == pytest.approx(0.825) for end in offsets.values())


def test_tokenizer_keeps_timing_across_five_second_boundaries():
    notes = [Note(pitch=60 + i, start=i * 2, duration=0.6, velocity=80) for i in range(8)]
    tokenizer = AbsTokenizer()
    tokens = tokenizer.tokenize(to_midi_dict(notes), add_eos_tok=False, add_dim_tok=False)
    assert tokens.count(tokenizer.time_tok) == 2
    assert tokenizer.calc_length_ms(tokens, onset=True) == 14000
    assert tokenizer.eos_tok not in tokens
    decoded = tokenizer.detokenize(tokens)
    assert [n["data"]["pitch"] for n in decoded.note_msgs] == list(range(60, 68))


def test_long_session_export():
    note = Note(pitch=60, start=3600, duration=90, velocity=70)
    assert midi_bytes([note]).startswith(b"MThd")


if __name__ == "__main__":
    main()
