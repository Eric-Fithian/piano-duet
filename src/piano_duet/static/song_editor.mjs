// Editing a Library song: its tempo, meter, key, bar lines and notes, with undo. Notes keep their written
// position in beats; times are seconds at the song's tempo, as the server stores them.

export const TICKS_PER_BEAT = 12;
export const METERS = ['2/4', '3/4', '4/4', '5/4', '3/8', '6/8', '7/8', '9/8', '12/8'];
const LETTERS = 'CDEFGAB';
const NATURALS = [0, 2, 4, 5, 7, 9, 11];
// The diatonic position (octave × 7 + letter) of each staff's top line: F5 on the treble staff, A3 on the bass.
const TOP_LINE = {treble: 5 * 7 + 3, bass: 3 * 7 + 5};

// Mirrors MusicalKey in key_tracking.py, so a key chosen while editing spells notes as the server would.
const TONICS = {
  major: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
  minor: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'],
};
const INTERVALS = {major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10]};

export function musicalKey(tonic, mode) {
  const name = TONICS[mode][tonic];
  const first = LETTERS.indexOf(name[0]);
  const pitchClasses = INTERVALS[mode].map(interval => (tonic + interval) % 12);
  const scaleNames = pitchClasses.map((pitch, index) => {
    const letter = (first + index) % 7;
    const alteration = ((pitch - NATURALS[letter] + 6) % 12 + 12) % 12 - 6;
    return LETTERS[letter] + (alteration > 0 ? '#'.repeat(alteration) : 'b'.repeat(-alteration));
  });
  return {name: `${name.replace('b', '♭').replace('#', '♯')} ${mode}`, tonic, mode, signature: name + (mode === 'minor' ? 'm' : ''),
    pitch_classes: pitchClasses, scale_names: scaleNames};
}

const ticks = (seconds, bpm) => Math.round(seconds * bpm / 60 * TICKS_PER_BEAT);
const seconds = (tick, bpm) => tick / TICKS_PER_BEAT * 60 / bpm;
const ordered = notes => [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);

// The same written notes at another tempo.
export function retime(notes, from, to) {
  return notes.map(note => ({...note, start: seconds(ticks(note.start, from), to), duration: seconds(ticks(note.duration, from), to)}));
}

// The bar lines move by one step of the meter: an eighth in /8 meters, otherwise a quarter.
export function barStep(meter) {
  return meter.endsWith('/8') ? 0.5 : 1;
}

// Moves every note by `beats`: later puts the bar lines earlier in the music, and earlier the reverse.
export function shiftNotes(notes, beats, bpm) {
  const offset = Math.round(beats * TICKS_PER_BEAT);
  if (Math.min(...notes.map(note => ticks(note.start, bpm))) + offset < 0) throw new Error('The first note cannot move before the start of the score.');
  return notes.map(note => ({...note, start: seconds(ticks(note.start, bpm) + offset, bpm)}));
}

// The pitch written `steps` half-spaces below a staff's top line, with the key signature's accidental.
export function staffPitch(clef, steps, key) {
  const position = TOP_LINE[clef] - steps;
  const letter = ((position % 7) + 7) % 7;
  const octave = Math.floor(position / 7);
  const name = key.scale_names.find(item => item[0] === LETTERS[letter]);
  const alteration = name ? [...name.slice(1)].reduce((sum, sign) => sum + (sign === '#' ? 1 : -1), 0) : 0;
  return 12 * (octave + 1) + NATURALS[letter] + alteration;
}

// A new note at `tick` lasts until the next attack on its staff, at most a beat and at least a sixteenth.
export function newNote(notes, {pitch, tick, staff}, bpm) {
  const next = Math.min(...notes.filter(note => note.staff === staff && ticks(note.start, bpm) > tick).map(note => ticks(note.start, bpm)));
  const length = Math.max(TICKS_PER_BEAT / 4, Math.min(TICKS_PER_BEAT, next - tick));
  return {pitch, start: seconds(tick, bpm), duration: seconds(length, bpm), velocity: 70, staff, voice: 0};
}

export class SongEditor {
  constructor(song) {
    this.draft = {bpm: song.bpm, meter: song.meter, tonic: song.key.tonic, mode: song.key.mode, notes: ordered(song.notes)};
    this.history = [];
    this.selected = null;
  }

  get dirty() {
    return this.history.length > 0;
  }

  apply(change) {
    const next = {...this.draft, ...change};
    if (next.notes.some(note => note.pitch < 21 || note.pitch > 108)) throw new Error('Notes must stay within the 88 keys.');
    this.history.push({draft: this.draft, selected: this.selected});
    this.draft = {...next, notes: ordered(next.notes)};
  }

  undo() {
    const previous = this.history.pop();
    if (!previous) return;
    this.draft = previous.draft;
    this.selected = previous.selected;
  }

  get key() {
    return musicalKey(this.draft.tonic, this.draft.mode);
  }

  // Retiming and moving bar lines keep the order of the notes, so the selection stays put.
  setTempo(bpm) {
    if (!Number.isInteger(bpm) || bpm < 30 || bpm > 240) throw new Error('Tempo must be a whole number from 30 to 240.');
    if (bpm !== this.draft.bpm) this.apply({bpm, notes: retime(this.draft.notes, this.draft.bpm, bpm)});
  }

  setMeter(meter) {
    if (!METERS.includes(meter)) throw new Error(`${meter} time is not supported.`);
    if (meter !== this.draft.meter) this.apply({meter});
  }

  setKey(tonic, mode) {
    if (tonic !== this.draft.tonic || mode !== this.draft.mode) this.apply({tonic, mode});
  }

  moveBarLines(direction) {
    this.apply({notes: shiftNotes(this.draft.notes, direction * barStep(this.draft.meter), this.draft.bpm)});
  }

  add(place) {
    const note = newNote(this.draft.notes, {pitch: staffPitch(place.clef, place.steps, this.key), tick: place.tick, staff: place.clef}, this.draft.bpm);
    if (this.draft.notes.some(other => other.pitch === note.pitch && Math.abs(other.start - note.start) < 1e-6)) return;
    this.apply({notes: [...this.draft.notes, note]});
    this.reselect(note);
  }

  remove() {
    if (this.selected === null) return;
    this.apply({notes: this.draft.notes.filter((_, index) => index !== this.selected)});
    this.selected = Math.min(this.selected, this.draft.notes.length - 1);
  }

  transpose(semitones) {
    if (this.selected === null) return;
    const note = {...this.draft.notes[this.selected], pitch: this.draft.notes[this.selected].pitch + semitones};
    this.apply({notes: this.draft.notes.map((other, index) => (index === this.selected ? note : other))});
    this.reselect(note);
  }

  step(direction) {
    if (this.selected === null) { this.selected = 0; return; }
    this.selected = Math.max(0, Math.min(this.draft.notes.length - 1, this.selected + direction));
  }

  reselect(note) {
    this.selected = note ? this.draft.notes.findIndex(other => other.pitch === note.pitch && Math.abs(other.start - note.start) < 1e-6) : null;
    if (this.selected === -1) this.selected = null;
  }

  request() {
    return {bpm: this.draft.bpm, meter: this.draft.meter, tonic: this.draft.tonic, mode: this.draft.mode, notes: this.draft.notes};
  }
}
