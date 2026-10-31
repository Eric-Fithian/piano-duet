import {localFetch} from './practice.mjs';

export function matchesReading(pitches, expected) {
  const targets = Array.isArray(expected) ? expected : [expected];
  return targets.every(pitch => pitches.includes(pitch))
    && pitches.every(pitch => targets.some(target => (pitch - target) % 12 === 0));
}

export function readingAttacks(target) {
  const attacks = [];
  target.forEach((note, index) => {
    const previous = attacks.at(-1);
    if (Number.isFinite(note.start) && previous?.start === note.start) previous.indices.push(index);
    else attacks.push({start: note.start, indices: [index]});
  });
  return attacks;
}

const LOCATE_ATTACKS = 3;

export class ReadingProgress {
  constructor(target, {bpm = null, end = null, tempo = bpm, locate = false} = {}) {
    this.target = target;
    if (bpm !== null && (!Number.isFinite(bpm) || !(bpm > 0) || !Number.isFinite(end) || target.some(note =>
      !Number.isFinite(note.start) || !(note.duration > 0) || note.start + note.duration > end + 0.00001))) {
      throw new Error('Timed reading needs a tempo, note durations, and the full score length.');
    }
    this.bpm = bpm;
    this.end = end;
    this.setTempo(tempo);
    this.time = 0;
    this.active = null;
    this.attacks = readingAttacks(target);
    this.polyphonic = this.attacks.some(attack => attack.indices.length > 1);
    const gaps = this.attacks.slice(1).map((attack, i) => attack.start - this.attacks[i].start).filter(gap => gap > 0);
    this.retrigger = Math.max(.06, Math.min(.22, ...gaps.map(gap => gap * .55)));
    this.chordWindow = this.polyphonic ? Math.max(.035, Math.min(.09, ...gaps.map(gap => gap * .4))) : .06;
    this.index = 0;
    this.groups = [];
    this.interruptions = new Set();
    this.mistakes = new Set();
    this.wrong = [];
    this.seen = new Map();
    this.latest = -1;
    this.streak = 0;
    this.bestStreak = 0;
    this.locate = locate;
    this.recent = [];
    this.missed = [];
    this.results = new Map();
  }
  get pitchesComplete() { return this.index === this.target.length; }
  get complete() { return this.pitchesComplete && !this.timing; }
  setTempo(tempo) {
    if (this.bpm !== null && !(Number.isFinite(tempo) && tempo > 0)) throw new Error('Timed reading needs a positive playing tempo.');
    this.tempo = tempo;
  }
  // Score seconds advance at the chosen tempo; grading uses only the real onsets.
  get rate() { return this.tempo / this.bpm; }
  get timing() {
    if (!this.active) return null;
    const {start, span, held} = this.active;
    const until = start + span / this.rate;
    const release = start + Math.min(held, span) / this.rate;
    if (this.time >= until) return null;
    const elapsed = Math.max(0, this.time - start);
    return {...this.active, until, release, elapsed,
      fraction: elapsed / (until - start),
      beat: Math.floor(elapsed * this.tempo / 60) + 1,
      beats: span * this.bpm / 60,
      resting: this.time >= release,
      scoreTime: this.active.scoreStart + elapsed * this.rate};
  }
  get displayIndex() { return this.wrong.length ? this.index : this.timing?.index ?? this.index; }
  get expected() { return this.attacks.find(attack => attack.indices[0] === this.index)?.indices.map(index => this.target[index].pitch) || []; }
  jump(ordinal) {
    const attack = this.attacks[ordinal];
    if (!attack) throw new Error('That position is outside the score.');
    this.index = attack.indices[0];
    this.wrong = [];
    this.active = null;
    this.missed = [];
    this.recent = [];
  }
  // Finds where the latest attacks were played, preferring the nearest place to the cursor.
  find(groups) {
    const here = this.attacks.findIndex(attack => attack.indices[0] === this.index);
    let best = null;
    for (let start = 0; start + groups.length <= this.attacks.length; start++) {
      if (!groups.every((pitches, i) => matchesReading(pitches, this.attacks[start + i].indices.map(index => this.target[index].pitch)))) continue;
      if (best === null || Math.abs(start - here) < Math.abs(best - here)) best = start;
    }
    return best;
  }
  advanceTime(time) {
    const before = [this.displayIndex, this.timing?.resting, this.complete];
    this.time = Math.max(this.time, time);
    const after = [this.displayIndex, this.timing?.resting, this.complete];
    return before.some((value, i) => value !== after[i]);
  }
  accept(notes, offset, stableUntil, time = stableUntil) {
    let changed = this.advanceTime(time);
    const fresh = notes.map(note => ({...note, start: note.start + offset}))
      .filter(note => note.start >= 0 && note.start > this.latest + 0.06
        && Math.abs(note.start - (this.seen.get(note.pitch) ?? -10)) > this.retrigger)
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const groups = [];
    for (const note of fresh) {
      const group = groups.at(-1);
      if (group && note.start - group[0].start <= this.chordWindow) group.push(note);
      else groups.push([note]);
    }
    for (const group of groups) {
      if (this.pitchesComplete || group[0].start > stableUntil) break;
      for (const note of group) this.seen.set(note.pitch, note.start);
      this.latest = Math.max(this.latest, group[0].start);
      this.groups.push(group);
      changed = true;
      const ordinal = this.attacks.findIndex(attack => attack.indices[0] === this.index);
      const attack = this.attacks[ordinal];
      const pitches = group.map(note => note.pitch);
      this.recent = [...this.recent, pitches].slice(-LOCATE_ATTACKS);
      if (matchesReading(pitches, this.expected)) {
        if (this.bpm !== null) {
          const next = this.attacks[this.attacks.indexOf(attack) + 1];
          const span = (next?.start ?? this.end) - attack.start;
          const duration = Math.max(...this.target.filter(note => note.start <= attack.start)
            .map(note => note.start + note.duration)) - attack.start;
          this.active = {index: this.index, start: group[0].start, scoreStart: attack.start, span, held: duration};
        }
        const clean = !attack.indices.some(index => this.mistakes.has(index));
        if (clean) {
          this.streak++;
          this.bestStreak = Math.max(this.bestStreak, this.streak);
        }
        this.results.set(ordinal, clean);
        this.index += attack.indices.length;
        this.wrong = [];
        this.missed = [];
      } else {
        for (const index of attack.indices) this.mistakes.add(index);
        this.missed.push(...attack.indices);
        this.wrong = pitches;
        this.streak = 0;
        const found = this.locate && this.recent.length === LOCATE_ATTACKS ? this.find(this.recent) : null;
        if (found !== null) {
          // The player moved elsewhere: those presses were not attempts at the cursor note.
          for (const index of this.missed) this.mistakes.delete(index);
          for (let i = found; i < found + LOCATE_ATTACKS; i++) this.results.set(i, true);
          if (found + LOCATE_ATTACKS === this.attacks.length) this.index = this.target.length;
          else this.jump(found + LOCATE_ATTACKS);
          this.wrong = [];
          this.missed = [];
          this.recent = [];
        }
      }
    }
    return changed;
  }
}

export class ConfirmedOnsets {
  constructor() { this.candidates = []; }
  accept(notes, offset, polyphonic = false) {
    this.candidates = this.candidates.filter(candidate => candidate.start >= offset);
    const confirmed = [];
    // Single-note reading can produce quieter harmonic guesses alongside the actual attack.
    const dominant = polyphonic ? notes : notes.filter(note => {
      const group = notes.filter(other => Math.abs(other.start - note.start) <= 0.06);
      const strongest = Math.max(...group.map(other => other.confidence * other.velocity));
      return group.some(other => other.confidence * other.velocity >= strongest * 0.75
        && (other.pitch - note.pitch) % 12 === 0);
    });
    for (const note of dominant) {
      const start = offset + note.start;
      const candidate = this.candidates.find(item => item.pitch === note.pitch && Math.abs(item.start - start) < 0.08);
      if (candidate) {
        candidate.count++;
        if (candidate.count >= 2) confirmed.push(note);
      } else this.candidates.push({pitch: note.pitch, start, count: 1});
    }
    return confirmed;
  }
}

export class ReadingStream {
  constructor({threshold, onChange, onComplete, onError, onTick = () => {}}) {
    Object.assign(this, {threshold, onChange, onComplete, onError, onTick});
    this.buffer = new Float32Array(32000);
    this.generation = 0;
    this.total = 0;
    this.pending = false;
    this.next = 3200;
    this.progress = null;
    this.confirmation = new ConfirmedOnsets();
  }
  reset(target, timing) {
    this.pause();
    this.total = 0;
    this.next = 3200;
    this.progress = new ReadingProgress(target, timing);
  }
  advance(target, timing) {
    if (!this.progress?.complete) throw new Error('Finish the current reading line before advancing.');
    const previous = this.progress;
    this.progress = new ReadingProgress(target, timing);
    this.progress.seen = new Map(previous.seen);
    this.progress.latest = previous.latest;
    this.progress.streak = previous.streak;
  }
  pause() {
    this.interrupt();
    this.generation++;
    this.controller?.abort();
    this.buffer.fill(0);
    this.confirmation = new ConfirmedOnsets();
    this.pending = false;
    this.next = this.total + 2048;
  }
  interrupt() {
    if (this.progress && !this.progress.complete && this.progress.groups.length) {
      this.progress.interruptions.add(this.progress.groups.length);
    }
  }
  feed(chunk) {
    if (!this.progress) return;
    this.buffer.copyWithin(0, chunk.length);
    this.buffer.set(chunk, this.buffer.length - chunk.length);
    this.total += chunk.length;
    if (this.progress.advanceTime(this.total / 16000)) this.onChange(this.progress);
    this.onTick(this.progress);
    if (this.pending || this.total < this.next) return;
    this.pending = true;
    this.next = this.total + 2048;
    const generation = this.generation;
    const offset = (this.total - this.buffer.length) / 16000;
    const controller = new AbortController();
    this.controller = controller;
    this.transcribe(this.buffer.slice(), controller.signal).then(async result => {
      if (generation !== this.generation) return;
      const notes = this.confirmation.accept(result.notes, offset, this.progress.polyphonic);
      await this.accept(notes, offset, offset + 1.75, generation, this.total / 16000);
    }).catch(error => {
      if (generation !== this.generation && error.name === 'AbortError') return;
      this.onError(error);
    }).finally(() => { if (generation === this.generation) this.pending = false; });
  }
  async accept(notes, offset, stableUntil, generation = this.generation, time = stableUntil) {
    while (generation === this.generation) {
      const progress = this.progress;
      if (progress.accept(notes, offset, stableUntil, time)) this.onChange(progress);
      this.onTick(progress);
      if (!progress.complete) return;
      await this.onComplete(progress);
      if (this.progress === progress) return;
    }
  }
  transcribe(audio, signal) {
    return listen(audio, this.threshold(), signal);
  }
}

async function listen(audio, threshold, signal) {
  const response = await localFetch(`/api/reading/listen?threshold=${threshold}`, {
    method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'X-Duet-Client': '1'},
    body: audio.buffer, signal,
  });
  if (!response.ok) throw new Error((await response.json()).detail || 'Live note recognition failed.');
  return response.json();
}
