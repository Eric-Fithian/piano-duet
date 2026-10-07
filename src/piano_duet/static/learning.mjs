export class LearningCycle {
  constructor() { this.reset(); }
  reset() {
    this.stage = 'idea';
    this.id = null;
    this.target = [];
    this.result = null;
    this.analysis = [];
  }
  beginIdea(id) {
    this.reset();
    this.id = id;
  }
  acceptLesson(event) {
    if (event.id !== this.id || !event.notes.length) throw new Error('The learning response belongs to a different round. Start a new round.');
    this.target = event.notes;
    this.analysis = event.analysis;
    this.stage = 'repeat';
  }
  acceptScore(result) {
    if (this.stage !== 'repeat' || !this.target.length) throw new Error('There is no practice target to score.');
    this.result = result;
    this.stage = 'idea';
  }
}

export function pitchName(pitch, key = null) {
  if (key?.pitch_classes?.includes(pitch % 12)) {
    const name = key.scale_names[key.pitch_classes.indexOf(pitch % 12)];
    const natural = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}[name[0]];
    const alteration = [...name.slice(1)].reduce((value, symbol) => value + (symbol === '#' ? 1 : -1), 0);
    return `${name.replaceAll('#', '♯').replaceAll('b', '♭')}${Math.floor((pitch - natural - alteration) / 12) - 1}`;
  }
  return `${['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

export function renderAnalysis(container, analysis) {
  container.replaceChildren();
  const rows = document.createDocumentFragment();
  for (const note of analysis) {
    const row = document.createElement('tr');
    if (note.changed) row.className = 'changed-note';
    const cells = [String(note.index + 1), `${note.start.toFixed(2)} s`, pitchName(note.played),
      `${(note.probability * 100).toFixed(2)}%`, `${(note.surprise * 100).toFixed(2)}%`,
      `${pitchName(note.expected)} · ${(note.expected_probability * 100).toFixed(2)}%`,
      note.changed ? `→ ${pitchName(note.corrected)}` : note.chord_collision ? 'Kept · chord overlap' : 'Kept'];
    for (const text of cells) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    rows.append(row);
  }
  container.append(rows);
}
