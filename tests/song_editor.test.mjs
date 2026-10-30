import test from 'node:test';
import assert from 'node:assert/strict';
import {SongEditor, barStep, musicalKey, newNote, retime, shiftNotes, staffPitch} from '../src/piano_duet/static/song_editor.mjs';

// MusicalKey(tonic, mode).to_dict() for all 24 keys, from key_tracking.py.
const SERVER_KEYS = [{"name": "C major", "tonic": 0, "mode": "major", "signature": "C", "pitch_classes": [0, 2, 4, 5, 7, 9, 11], "scale_names": ["C", "D", "E", "F", "G", "A", "B"]}, {"name": "D♭ major", "tonic": 1, "mode": "major", "signature": "Db", "pitch_classes": [1, 3, 5, 6, 8, 10, 0], "scale_names": ["Db", "Eb", "F", "Gb", "Ab", "Bb", "C"]}, {"name": "D major", "tonic": 2, "mode": "major", "signature": "D", "pitch_classes": [2, 4, 6, 7, 9, 11, 1], "scale_names": ["D", "E", "F#", "G", "A", "B", "C#"]}, {"name": "E♭ major", "tonic": 3, "mode": "major", "signature": "Eb", "pitch_classes": [3, 5, 7, 8, 10, 0, 2], "scale_names": ["Eb", "F", "G", "Ab", "Bb", "C", "D"]}, {"name": "E major", "tonic": 4, "mode": "major", "signature": "E", "pitch_classes": [4, 6, 8, 9, 11, 1, 3], "scale_names": ["E", "F#", "G#", "A", "B", "C#", "D#"]}, {"name": "F major", "tonic": 5, "mode": "major", "signature": "F", "pitch_classes": [5, 7, 9, 10, 0, 2, 4], "scale_names": ["F", "G", "A", "Bb", "C", "D", "E"]}, {"name": "G♭ major", "tonic": 6, "mode": "major", "signature": "Gb", "pitch_classes": [6, 8, 10, 11, 1, 3, 5], "scale_names": ["Gb", "Ab", "Bb", "Cb", "Db", "Eb", "F"]}, {"name": "G major", "tonic": 7, "mode": "major", "signature": "G", "pitch_classes": [7, 9, 11, 0, 2, 4, 6], "scale_names": ["G", "A", "B", "C", "D", "E", "F#"]}, {"name": "A♭ major", "tonic": 8, "mode": "major", "signature": "Ab", "pitch_classes": [8, 10, 0, 1, 3, 5, 7], "scale_names": ["Ab", "Bb", "C", "Db", "Eb", "F", "G"]}, {"name": "A major", "tonic": 9, "mode": "major", "signature": "A", "pitch_classes": [9, 11, 1, 2, 4, 6, 8], "scale_names": ["A", "B", "C#", "D", "E", "F#", "G#"]}, {"name": "B♭ major", "tonic": 10, "mode": "major", "signature": "Bb", "pitch_classes": [10, 0, 2, 3, 5, 7, 9], "scale_names": ["Bb", "C", "D", "Eb", "F", "G", "A"]}, {"name": "B major", "tonic": 11, "mode": "major", "signature": "B", "pitch_classes": [11, 1, 3, 4, 6, 8, 10], "scale_names": ["B", "C#", "D#", "E", "F#", "G#", "A#"]}, {"name": "C minor", "tonic": 0, "mode": "minor", "signature": "Cm", "pitch_classes": [0, 2, 3, 5, 7, 8, 10], "scale_names": ["C", "D", "Eb", "F", "G", "Ab", "Bb"]}, {"name": "C♯ minor", "tonic": 1, "mode": "minor", "signature": "C#m", "pitch_classes": [1, 3, 4, 6, 8, 9, 11], "scale_names": ["C#", "D#", "E", "F#", "G#", "A", "B"]}, {"name": "D minor", "tonic": 2, "mode": "minor", "signature": "Dm", "pitch_classes": [2, 4, 5, 7, 9, 10, 0], "scale_names": ["D", "E", "F", "G", "A", "Bb", "C"]}, {"name": "E♭ minor", "tonic": 3, "mode": "minor", "signature": "Ebm", "pitch_classes": [3, 5, 6, 8, 10, 11, 1], "scale_names": ["Eb", "F", "Gb", "Ab", "Bb", "Cb", "Db"]}, {"name": "E minor", "tonic": 4, "mode": "minor", "signature": "Em", "pitch_classes": [4, 6, 7, 9, 11, 0, 2], "scale_names": ["E", "F#", "G", "A", "B", "C", "D"]}, {"name": "F minor", "tonic": 5, "mode": "minor", "signature": "Fm", "pitch_classes": [5, 7, 8, 10, 0, 1, 3], "scale_names": ["F", "G", "Ab", "Bb", "C", "Db", "Eb"]}, {"name": "F♯ minor", "tonic": 6, "mode": "minor", "signature": "F#m", "pitch_classes": [6, 8, 9, 11, 1, 2, 4], "scale_names": ["F#", "G#", "A", "B", "C#", "D", "E"]}, {"name": "G minor", "tonic": 7, "mode": "minor", "signature": "Gm", "pitch_classes": [7, 9, 10, 0, 2, 3, 5], "scale_names": ["G", "A", "Bb", "C", "D", "Eb", "F"]}, {"name": "G♯ minor", "tonic": 8, "mode": "minor", "signature": "G#m", "pitch_classes": [8, 10, 11, 1, 3, 4, 6], "scale_names": ["G#", "A#", "B", "C#", "D#", "E", "F#"]}, {"name": "A minor", "tonic": 9, "mode": "minor", "signature": "Am", "pitch_classes": [9, 11, 0, 2, 4, 5, 7], "scale_names": ["A", "B", "C", "D", "E", "F", "G"]}, {"name": "B♭ minor", "tonic": 10, "mode": "minor", "signature": "Bbm", "pitch_classes": [10, 0, 1, 3, 5, 6, 8], "scale_names": ["Bb", "C", "Db", "Eb", "F", "Gb", "Ab"]}, {"name": "B minor", "tonic": 11, "mode": "minor", "signature": "Bm", "pitch_classes": [11, 1, 2, 4, 6, 7, 9], "scale_names": ["B", "C#", "D", "E", "F#", "G", "A"]}];

const note = (pitch, beat, beats = 1, staff = 'treble', bpm = 60) => ({pitch, start: beat * 60 / bpm, duration: beats * 60 / bpm, velocity: 80, staff, voice: 0});
const song = {bpm: 60, meter: '4/4', key: musicalKey(0, 'major'), notes: [note(60, 0), note(64, 1), note(67, 2), note(48, 0, 4, 'bass')]};

test('keys are spelled exactly as the server spells them', () => {
  for (const key of SERVER_KEYS) assert.deepEqual(musicalKey(key.tonic, key.mode), key);
});

test('a staff position becomes the pitch the key signature gives it', () => {
  const c = musicalKey(0, 'major');
  const d = musicalKey(2, 'major');
  assert.equal(staffPitch('treble', 0, c), 77);
  assert.equal(staffPitch('treble', 8, c), 64, 'the bottom line is E4');
  assert.equal(staffPitch('treble', 10, c), 60, 'one ledger line below is middle C');
  assert.equal(staffPitch('bass', 0, c), 57);
  assert.equal(staffPitch('bass', -2, c), 60);
  assert.equal(staffPitch('treble', 0, d), 78, 'F is sharp in D major');
  assert.equal(staffPitch('treble', 2, musicalKey(5, 'major')), 74);
  assert.equal(staffPitch('treble', 1, musicalKey(5, 'major')), 76);
  assert.equal(staffPitch('treble', 4, musicalKey(5, 'major')), 70, 'B is flat in F major');
});

test('retiming keeps beats, and bar lines move by the meter\'s step', () => {
  const slower = retime(song.notes, 60, 30);
  assert.deepEqual(slower.map(n => n.start), [0, 2, 4, 0]);
  assert.equal(slower[3].duration, 8);
  assert.equal(barStep('6/8'), 0.5);
  assert.equal(barStep('3/4'), 1);
  assert.deepEqual(shiftNotes(song.notes, 0.5, 60).map(n => n.start), [0.5, 1.5, 2.5, 0.5]);
  assert.throws(() => shiftNotes(song.notes, -1, 60), /before the start/);
});

test('a new note lasts until the next attack on its staff, at most a beat', () => {
  assert.equal(newNote(song.notes, {pitch: 62, tick: 6, staff: 'treble'}, 60).duration, 0.5);
  assert.equal(newNote(song.notes, {pitch: 72, tick: 36, staff: 'treble'}, 60).duration, 1);
  assert.equal(newNote(song.notes, {pitch: 50, tick: 3, staff: 'bass'}, 60).duration, 1);
});

test('edits can be undone, and selection follows the edited note', () => {
  const editor = new SongEditor(song);
  assert.equal(editor.dirty, false);
  editor.selected = editor.draft.notes.findIndex(n => n.pitch === 64);
  editor.transpose(1);
  assert.equal(editor.draft.notes[editor.selected].pitch, 65);
  editor.remove();
  assert.ok(!editor.draft.notes.some(n => n.pitch === 65));
  editor.add({clef: 'treble', steps: 8, tick: 12});
  assert.equal(editor.draft.notes[editor.selected].pitch, 64);
  editor.setMeter('3/4');
  editor.setKey(9, 'minor');
  editor.setTempo(90);
  assert.equal(editor.key.name, 'A minor');
  assert.equal(editor.request().bpm, 90);
  for (let i = 0; i < 6; i++) editor.undo();
  assert.equal(editor.dirty, false);
  assert.deepEqual(editor.request().notes.map(n => n.pitch), [48, 60, 64, 67]);
  assert.throws(() => { editor.selected = 0; editor.transpose(-40); }, /88 keys/);
});
