"""Generate synthetic note-token fixtures with the score model's original tokenizer."""

import json
import subprocess
import tempfile
from pathlib import Path

from piano_duet.notes import Note, midi_bytes

OUTPUT = Path('tests/fixtures/score-input.json')


def main():
    notes = []
    for index in range(144):
        start = round((index // 2) * 0.173 + (0.0005 if index % 7 == 0 else 0), 4)
        duration = round(0.08 + (index % 11) * 0.0375, 4)
        notes.append(Note(pitch=36 + (index * 7) % 60, start=start, duration=duration,
                          velocity=1 + (index * 17) % 127))
    notes.append(Note(pitch=100, start=0.123, duration=0.0001, velocity=70))
    notes.reverse()
    with tempfile.TemporaryDirectory(dir='.cache/m2st') as directory:
        midi = Path(directory) / 'input.mid'
        midi.write_bytes(midi_bytes(notes))
        command = ['.cache/m2st/venv/bin/python', '-I', '-c', '''
import json, sys
sys.path.insert(0, ".cache/m2st/repo/midi2scoretransformer")
from tokenizer import MultistreamTokenizer
streams = MultistreamTokenizer.tokenize_midi(sys.argv[1])
print(json.dumps({name: (value.tolist() if name == "pad" else value.argmax(-1).tolist()) for name, value in streams.items()}))
''', str(midi)]
        result = subprocess.run(command, capture_output=True, text=True, check=True)
    expected = json.loads(result.stdout)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({'notes': [note.model_dump() for note in notes], 'expected': expected}) + '\n')
    print(f'{OUTPUT}: {len(notes)} input notes, {len(expected["pad"])} tokenized notes')


if __name__ == '__main__':
    main()
