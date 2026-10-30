const TICKS_PER_BEAT = 4;
const DURATIONS = [
  {ticks: 16, value: 'w'}, {ticks: 12, value: 'h', dotted: true},
  {ticks: 8, value: 'h'}, {ticks: 6, value: 'q', dotted: true},
  {ticks: 4, value: 'q'}, {ticks: 3, value: '8', dotted: true},
  {ticks: 2, value: '8'}, {ticks: 1, value: '16'},
];
const SHARPS = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLATS = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];

export function estimateTempo(notes) {
  const starts = [];
  for (const note of [...notes].sort((a, b) => a.start - b.start)) {
    if (!starts.length || note.start - starts.at(-1) > 0.07) starts.push(note.start);
  }
  const intervals = starts.slice(1).map((value, i) => value - starts[i])
    .filter(value => value >= 0.12 && value <= 2);
  if (intervals.length < 2) return 120;
  const median = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
  let best = {bpm: 120, error: Infinity};
  for (let bpm = 55; bpm <= 190; bpm++) {
    const beat = 60 / bpm;
    const residual = intervals.reduce((sum, interval) => {
      const beats = interval / beat;
      return sum + Math.abs(beats - Math.round(beats * 4) / 4);
    }, 0) / intervals.length;
    const error = residual + 0.045 * Math.abs(Math.log2(median / beat))
      + 0.002 * Math.abs(Math.log2(bpm / 120));
    if (error < best.error) best = {bpm, error};
  }
  return best.bpm;
}

export function spellPitch(pitch, flats = false, key = null) {
  const degree = key ? key.pitch_classes.indexOf(pitch % 12) : -1;
  let name = degree >= 0 ? key.scale_names[degree].toLowerCase() : (flats ? FLATS : SHARPS)[pitch % 12];
  if (key?.mode === 'minor' && pitch % 12 === (key.tonic + 11) % 12) {
    const seventh = key.scale_names[6].toLowerCase();
    name = seventh.length > 1 && seventh.endsWith('b') ? seventh.slice(0, -1) : seventh + '#';
  }
  const natural = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11}[name[0]];
  const alteration = [...name.slice(1)].reduce((sum, sign) => sum + (sign === '#' ? 1 : -1), 0);
  const octave = Math.round((pitch - natural - alteration) / 12) - 1;
  return {key: `${name}/${octave}`, letter: `${name[0]}/${octave}`, accidental: name.slice(1) || 'n'};
}

export function quantizeNotes(notes, bpm, {exact = false, ticksPerBeat = TICKS_PER_BEAT} = {}) {
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 240) throw new Error('Notation tempo must be 30–240 BPM.');
  if (!notes.length) return [];
  // Grace notes take no written time; createScore attaches them to the note they ornament.
  const sorted = notes.map((note, id) => ({...note, id})).filter(note => !note.grace).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  if (!sorted.length) return [];
  const origin = exact ? 0 : sorted[0].start;
  const beat = 60 / bpm;
  const unit = beat / ticksPerBeat;
  const chordWindow = exact ? 0.00001 : Math.min(0.06, beat * 0.18);
  let cluster = sorted[0].start;
  for (const note of sorted) {
    if (!Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.duration <= 0
        || !Number.isInteger(note.pitch) || note.pitch < 21 || note.pitch > 108) throw new Error('Invalid note in sheet music.');
    if (note.start - cluster > chordWindow) cluster = note.start;
    note.cluster = cluster;
    note.staff = note.staff || (note.pitch < 60 ? 'bass' : 'treble');
  }
  const result = [];
  for (const note of sorted) {
    let end = note.start + note.duration;
    const following = sorted.find(other => other.staff === note.staff && other.cluster > note.cluster + chordWindow);
    // Small articulation gaps usually denote a played quarter/eighth, not a written rest.
    if (!exact && following && end < following.cluster && following.cluster - end <= beat * 0.25) end = following.cluster;
    const start = Math.max(0, Math.round((note.cluster - origin) / unit));
    const finish = Math.max(start + 1, Math.round((end - origin) / unit));
    const duplicate = result.find(other => other.pitch === note.pitch && other.staff === note.staff && other.start === start);
    if (duplicate) duplicate.end = Math.max(duplicate.end, finish);
    else result.push({id: note.id, pitch: note.pitch, staff: note.staff, voice: note.voice || 0, start, end: finish});
  }
  // A repeated attack ends the previous written instance of the same pitch on that staff.
  for (const note of result) {
    const next = result.find(other => other.pitch === note.pitch && other.staff === note.staff && other.start > note.start);
    if (next) note.end = Math.min(note.end, next.start);
  }
  return result;
}

function splitDuration(start, end, meter, ticksPerBeat) {
  const result = [];
  let cursor = start;
  const beatGroup = ['6/8', '9/8', '12/8'].includes(meter) ? ticksPerBeat * 1.5 : ticksPerBeat;
  const durations = DURATIONS.map(duration => ({...duration, ticks: duration.ticks * ticksPerBeat / 4}));
  while (cursor < end) {
    const remaining = end - cursor;
    const available = cursor % beatGroup ? Math.min(remaining, beatGroup - cursor % beatGroup) : remaining;
    const triplet = ticksPerBeat === 12 && (cursor % 3 !== 0 || available % 3 !== 0);
    const duration = triplet ? {ticks: 4, value: '8', tuplet: 3} : durations.find(item => item.ticks <= available);
    if (!duration || duration.ticks > available) throw new Error('The written rhythm does not fit the notation grid.');
    result.push({...duration, start: cursor, end: cursor + duration.ticks});
    cursor += duration.ticks;
  }
  return result;
}

function graceOrigin(notes, exact) {
  return exact ? 0 : Math.min(...notes.filter(note => !note.grace).map(note => note.start));
}

// Each grace note joins the written note its staff attacks at the same tick, ahead of that note's own pitches.
function attachGraces(notes, bars, {bpm, ticksPerBeat, origin}) {
  const unit = 60 / bpm / ticksPerBeat;
  notes.forEach((note, id) => {
    if (!note.grace) return;
    const staff = note.staff || (note.pitch < 60 ? 'bass' : 'treble');
    const tick = Math.max(0, Math.round((note.start - origin) / unit));
    const bar = bars.find(item => item.start <= tick && tick < item.end);
    const part = bar && [...bar[staff], ...(bar.second[staff] || [])]
      .find(item => item.start === tick && item.notes.some(written => !written.tied));
    if (part) (part.graces ||= []).push({pitch: note.pitch, id});
  });
}

export function createScore(notes, {bpm = 120, meter = '4/4', exact = false, bars: requestedBars = 0} = {}) {
  if (!['2/4', '3/4', '4/4', '5/4', '3/8', '6/8', '7/8', '9/8', '12/8'].includes(meter)) throw new Error('Unsupported time signature.');
  const [numerator, denominator] = meter.split('/').map(Number);
  const ticksPerBeat = exact ? 12 : 4;
  const barTicks = numerator * 4 * ticksPerBeat / denominator;
  const quantized = quantizeNotes(notes, bpm, {exact, ticksPerBeat});
  const length = Math.max(barTicks, requestedBars * barTicks, ...quantized.map(note => note.end));
  const bars = [];
  const parts = (bar, selected) => {
    const result = [];
    const boundaries = [...new Set([bar.start, bar.end,
      ...selected.flatMap(note => [Math.max(bar.start, note.start), Math.min(bar.end, note.end)])])].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index++) {
      const from = boundaries[index], to = boundaries[index + 1];
      const active = selected.filter(note => note.start <= from && note.end > from).sort((a, b) => a.pitch - b.pitch);
      for (const duration of splitDuration(from - bar.start, to - bar.start, meter, ticksPerBeat)) {
        result.push({...duration, start: duration.start + bar.start, end: duration.end + bar.start,
          notes: active.map(note => ({pitch: note.pitch, id: note.id, tied: note.start < duration.start + bar.start}))});
      }
    }
    return result;
  };
  for (let start = 0; start < length; start += barTicks) {
    const bar = {start, end: start + barTicks, treble: [], bass: [], second: {treble: null, bass: null}};
    for (const staff of ['treble', 'bass']) {
      const selected = quantized.filter(note => note.staff === staff && note.start < bar.end && note.end > bar.start);
      bar[staff] = parts(bar, selected.filter(note => note.voice === 0));
      // A written second voice (a held bass under moving notes) gets its own stems instead of a chain of ties.
      const second = selected.filter(note => note.voice === 1);
      if (second.length) bar.second[staff] = parts(bar, second);
    }
    bars.push(bar);
  }
  attachGraces(notes, bars, {bpm, exact, ticksPerBeat, origin: quantized.length ? graceOrigin(notes, exact) : 0});
  return {bars, bpm, meter, barTicks, quantized, ticksPerBeat};
}
