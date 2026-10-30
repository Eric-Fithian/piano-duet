import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfirmedOnsets, matchesReading, ReadingProgress, ReadingStream} from '../src/piano_duet/static/reading.mjs';

const note = (pitch, start) => ({pitch, start, velocity: 80, confidence: 0.9});
const target = (...pitches) => pitches.map(pitch => ({pitch}));

test('octave duplicates count only when the expected octave is actually present', () => {
  assert.ok(matchesReading([48, 60], 48));
  assert.ok(matchesReading([48, 60, 72], 60));
  assert.equal(matchesReading([60], 48), false);
  assert.equal(matchesReading([48, 60, 64], 48), false);
  assert.equal(matchesReading([], 48), false);
  const progress = new ReadingProgress(target(48, 50));
  progress.accept([note(48, 0.3), note(60, 0.32)], 0, 1);
  assert.equal(progress.index, 1);
  assert.equal(progress.mistakes.size, 0);
  assert.equal(progress.groups[0].length, 2);
});

test('the strength filter preserves a quieter fundamental beside its octave', () => {
  const detector = new ConfirmedOnsets();
  const notes = [{...note(48, 1), velocity: 35}, note(60, 1.02)];
  detector.accept(notes, 0);
  assert.deepEqual(detector.accept(notes, 0).map(note => note.pitch), [48, 60]);
});

test('one-window phantom notes are rejected while stable attacks are confirmed', () => {
  const detector = new ConfirmedOnsets();
  assert.deepEqual(detector.accept([note(67, 1), note(48, 1.02)], 0), []);
  assert.deepEqual(detector.accept([note(67, 0.81)], 0.2).map(n => n.pitch), [67]);
  assert.deepEqual(detector.accept([note(67, 0.59)], 0.4).map(n => n.pitch), [67]);
  detector.accept([], 4);
  assert.equal(detector.candidates.length, 0);
});

test('single-note reading rejects much weaker harmonic guesses but keeps comparable chord attacks', () => {
  const detector = new ConfirmedOnsets();
  const chord = [note(67, 1), {...note(48, 1.02), velocity: 43}];
  detector.accept(chord, 0);
  assert.deepEqual(detector.accept(chord.map(n => ({...n, start: n.start - 0.2})), 0.2).map(n => n.pitch), [67]);
  const balanced = new ConfirmedOnsets();
  const pair = [note(60, 1), note(64, 1.01)];
  balanced.accept(pair, 0);
  assert.equal(balanced.accept(pair.map(n => ({...n, start: n.start - 0.2})), 0.2).length, 2);
});

test('a wrong press waits for correction and preserves first-try mistakes', () => {
  const progress = new ReadingProgress(target(60, 62));
  progress.accept([note(61, 0.3)], 0, 1);
  assert.equal(progress.index, 0);
  assert.deepEqual(progress.wrong, [61]);
  progress.accept([note(60, 0.8)], 0, 1);
  assert.equal(progress.index, 1);
  assert.deepEqual(progress.wrong, []);
  assert.ok(progress.mistakes.has(0));
  progress.accept([note(62, 1.3)], 0, 2);
  assert.ok(progress.complete);
  assert.equal(progress.groups.length, 3);
});

test('the streak counts clean first tries, resets on a mistake, and carries into the next score', async () => {
  const stream = new ReadingStream({onChange() {}, onComplete() { stream.advance(target(65)); }});
  stream.reset(target(60, 62, 64));
  await stream.accept([note(60, 0.3), note(62, 0.8)], 0, 1);
  assert.equal(stream.progress.streak, 2);
  await stream.accept([note(63, 1.3)], 0, 2);
  assert.equal(stream.progress.streak, 0);
  await stream.accept([note(64, 1.8), note(65, 2.4)], 0, 3);
  assert.equal(stream.progress.target[0].pitch, 65);
  assert.equal(stream.progress.streak, 1);
});

test('overlapping windows and onset jitter do not turn a held note into repeated presses', () => {
  const progress = new ReadingProgress(target(60, 60));
  progress.accept([note(60, 1)], 0, 1.75);
  progress.accept([note(60, 0.81)], 0.2, 1.95);
  progress.accept([note(60, 0.59)], 0.4, 2.15);
  assert.equal(progress.index, 1);
  progress.accept([note(60, 1.2)], 0.4, 2.15);
  assert.ok(progress.complete);
});

test('a late alternative pitch for an already classified attack cannot create a second press', () => {
  const progress = new ReadingProgress(target(60, 62));
  progress.accept([note(60, 1)], 0, 1.75);
  progress.accept([note(48, 0.78)], 0.2, 1.95);
  assert.equal(progress.index, 1);
  assert.equal(progress.groups.length, 1);
  progress.accept([note(62, 1.3)], 0.2, 1.95);
  assert.ok(progress.complete);
  assert.ok(progress.groups[1][0].start > progress.groups[0][0].start);
});

test('an extra note in a chord is an error even when the target is present', () => {
  const progress = new ReadingProgress(target(60));
  progress.accept([note(60, 0.3), note(64, 0.33)], 0, 1);
  assert.equal(progress.index, 0);
  assert.deepEqual(progress.wrong, [60, 64]);
  progress.accept([note(60, 0.9)], 0, 1);
  assert.ok(progress.complete);
});

test('future attacks wait for enough context and negative padding never counts', () => {
  const progress = new ReadingProgress(target(60));
  progress.accept([note(60, 0.2), note(60, 1.8)], -0.5, 1.25);
  assert.equal(progress.index, 0);
  progress.accept([note(60, 1.6)], -0.3, 1.45);
  assert.ok(progress.complete);
});

test('a finished score cannot consume attacks intended for another score', () => {
  const progress = new ReadingProgress(target(60));
  progress.accept([note(60, 0.3), note(62, 0.8)], 0, 1);
  assert.equal(progress.groups.length, 1);
  assert.equal(progress.accept([note(64, 1.3)], 0, 2), false);
});

test('continuous reading hands later attacks in the same window to the preview', async () => {
  const completed = [];
  const stream = new ReadingStream({onChange() {}, onComplete(progress) {
    completed.push(progress);
    stream.advance(target(62, 64));
  }});
  stream.reset(target(60));
  await stream.accept([note(60, 0.3), note(62, 0.8)], 0, 1);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].groups.flat().map(n => n.pitch), [60]);
  assert.equal(stream.progress.index, 1);
  assert.deepEqual(stream.progress.groups.flat().map(n => n.pitch), [62]);
});

test('the same pitch across a line boundary still needs a fresh attack', async () => {
  let completed = 0;
  const stream = new ReadingStream({onChange() {}, onComplete() {
    completed++;
    stream.advance(target(60));
  }});
  stream.reset(target(60));
  await stream.accept([note(60, 1)], 0, 1.75);
  await stream.accept([note(60, 0.81)], 0.2, 1.95);
  assert.equal(completed, 1);
  assert.equal(stream.progress.index, 0);
  await stream.accept([note(60, 1.2)], 0.4, 2.15);
  assert.equal(completed, 2);
});

test('a delayed next line preserves remaining attacks and keeps collecting audio', async () => {
  let resume;
  const stream = new ReadingStream({onChange() {}, async onComplete() {
    await new Promise(resolve => { resume = resolve; });
    stream.advance(target(62, 64));
  }});
  stream.reset(target(60));
  stream.pending = true;
  const accepting = stream.accept([note(60, 0.3), note(62, 0.8)], 0, 1);
  stream.feed(new Float32Array(2048).fill(0.5));
  assert.equal(stream.total, 2048);
  assert.equal(stream.buffer.at(-1), 0.5);
  resume();
  await accepting;
  assert.equal(stream.progress.index, 1);
  assert.equal(stream.total, 2048);
  assert.equal(stream.buffer.at(-1), 0.5);
});

test('changing exercises while a boundary is waiting discards the previous window', async () => {
  let resume;
  const stream = new ReadingStream({onChange() {}, async onComplete() {
    await new Promise(resolve => { resume = resolve; });
  }});
  stream.reset(target(60));
  const accepting = stream.accept([note(60, 0.3), note(62, 0.8)], 0, 1);
  stream.reset(target(62));
  resume();
  await accepting;
  assert.equal(stream.progress.index, 0);
  assert.deepEqual(stream.progress.groups, []);
});

test('microphone pauses mark an attack boundary without losing pitch progress', () => {
  const stream = new ReadingStream({});
  stream.reset(target(60, 62, 64));
  stream.progress.accept([note(60, 0.5), note(62, 1)], 0, 2);
  stream.pause();
  stream.pause();
  assert.deepEqual([...stream.progress.interruptions], [2]);
  assert.equal(stream.progress.index, 2);
  stream.progress.accept([note(64, 2)], 0, 3);
  stream.advance(target(65));
  assert.deepEqual([...stream.progress.interruptions], []);
  assert.equal(stream.progress.latest, 2);
});

test('written chords advance as a single attack, with every exact pitch required', () => {
  const progress = new ReadingProgress([note(48, 0), note(60, 0), note(64, 0), note(62, 1)]);
  progress.accept([note(48, .5), note(60, .52)], 0, 1);
  assert.equal(progress.index, 0);
  assert.deepEqual([...progress.mistakes], [0, 1, 2]);
  progress.accept([note(48, 1.1), note(60, 1.11), note(64, 1.12), note(76, 1.14)], 0, 2);
  assert.equal(progress.index, 3);
  progress.accept([note(62, 2.1)], 0, 3);
  assert.ok(progress.complete);
  assert.equal(progress.groups.length, 3);
});

test('polyphonic reading preserves quieter written chord members after confirmation', () => {
  const detector = new ConfirmedOnsets();
  const chord = [note(60, 1), {...note(64, 1.02), velocity: 35}];
  detector.accept(chord, 0, true);
  assert.deepEqual(detector.accept(chord, 0, true).map(n => n.pitch), [60, 64]);
});

test('fast repeated notes and interlocking hands keep their separate attacks', () => {
  const notes = [note(48, 0), note(60, 0), note(60, .12), note(48, .24), note(60, .36)];
  const progress = new ReadingProgress(notes);
  progress.accept(notes.map(n => ({...n, start: n.start + 1})), 0, 2);
  assert.ok(progress.complete);
  assert.equal(progress.groups.length, 4);
});

test('a final whole note keeps its cursor for four beats after the actual onset', () => {
  const progress = new ReadingProgress([{pitch: 60, start: 0, duration: 4}], {bpm: 60, end: 4});
  progress.accept([note(60, 1)], 0, 1.25, 1.5);
  assert.equal(progress.index, 1);
  assert.equal(progress.displayIndex, 0);
  assert.equal(progress.complete, false);
  assert.equal(progress.timing.beat, 1);
  progress.advanceTime(4.99);
  assert.equal(progress.timing.beat, 4);
  assert.equal(progress.displayIndex, 0);
  assert.equal(progress.complete, false);
  assert.ok(progress.advanceTime(5));
  assert.equal(progress.complete, true);
});

test('a slower chosen tempo stretches holds in real time without changing the written beats', () => {
  const progress = new ReadingProgress([{pitch: 60, start: 0, duration: 4}], {bpm: 60, end: 4, tempo: 30});
  progress.accept([note(60, 1)], 0, 1.25, 1.5);
  assert.equal(progress.timing.beats, 4);
  progress.advanceTime(8.99);
  assert.equal(progress.timing.beat, 4);
  assert.equal(progress.timing.scoreTime, 3.995);
  assert.equal(progress.complete, false);
  progress.setTempo(60);
  assert.equal(progress.complete, true);
  assert.throws(() => progress.setTempo(0));
});

test('half notes, rests, and trailing silence retain their written time', () => {
  const progress = new ReadingProgress([
    {pitch: 60, start: 0, duration: 2}, {pitch: 62, start: 3, duration: 1},
  ], {bpm: 60, end: 6});
  progress.accept([note(60, 1)], 0, 1.5);
  assert.equal(progress.timing.resting, false);
  progress.advanceTime(3);
  assert.equal(progress.timing.resting, true);
  assert.equal(progress.displayIndex, 0);
  progress.advanceTime(4);
  assert.equal(progress.displayIndex, 1);
  progress.accept([note(62, 4)], 0, 4.5);
  progress.advanceTime(5);
  assert.equal(progress.timing.resting, true);
  progress.advanceTime(6.99);
  assert.equal(progress.complete, false);
  progress.advanceTime(7);
  assert.equal(progress.complete, true);
});

test('the tempo determines the whole-note countdown without delaying it by recognition latency', () => {
  const progress = new ReadingProgress([{pitch: 60, start: 0, duration: 2}], {bpm: 120, end: 2});
  progress.accept([note(60, 1)], 0, 1.25, 1.7);
  assert.equal(progress.timing.beats, 4);
  assert.equal(progress.timing.beat, 2);
  progress.advanceTime(3);
  assert.ok(progress.complete);
});

test('early and late presses keep their real timestamps for rhythm scoring', () => {
  const progress = new ReadingProgress([
    {pitch: 60, start: 0, duration: 2}, {pitch: 62, start: 2, duration: 1},
    {pitch: 64, start: 3, duration: 1},
  ], {bpm: 60, end: 4});
  progress.accept([note(60, 1), note(62, 1.8)], 0, 2);
  assert.deepEqual(progress.groups.map(group => group[0].start), [1, 1.8]);
  progress.advanceTime(5);
  assert.equal(progress.complete, false);
  assert.equal(progress.displayIndex, 2);
  progress.accept([note(64, 6)], 0, 6.5);
  assert.equal(progress.complete, false);
  progress.advanceTime(7);
  assert.equal(progress.complete, true);
});

test('a held lower voice continues through the final upper-voice attack', () => {
  const progress = new ReadingProgress([
    {pitch: 48, start: 0, duration: 4}, {pitch: 60, start: 0, duration: 1},
    {pitch: 62, start: 1, duration: 1},
  ], {bpm: 60, end: 4});
  progress.accept([note(48, 1), note(60, 1.02), note(62, 2)], 0, 2.5);
  progress.advanceTime(4);
  assert.equal(progress.complete, false);
  assert.equal(progress.timing.resting, false);
  progress.advanceTime(5);
  assert.equal(progress.complete, true);
});

test('timed reading completes on silence after the last note, then hands the next attack forward', async () => {
  const completed = [];
  const stream = new ReadingStream({onChange() {}, onComplete(progress) {
    completed.push(progress);
    stream.advance([{pitch: 62, start: 0, duration: 1}], {bpm: 60, end: 1});
  }});
  stream.reset([{pitch: 60, start: 0, duration: 4}], {bpm: 60, end: 4});
  await stream.accept([note(60, 1)], 0, 1.5);
  assert.equal(completed.length, 0);
  await stream.accept([], 2, 4.9);
  assert.equal(completed.length, 0);
  await stream.accept([note(62, 1)], 4, 5.25);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].groups.flat().map(n => n.pitch), [60]);
  assert.equal(stream.progress.displayIndex, 0);
  assert.equal(stream.progress.index, 1);
  assert.equal(stream.progress.complete, false);
});

test('audio capture advances the visual clock even while transcription is pending', () => {
  let ticks = 0;
  const stream = new ReadingStream({onChange() {}, onTick() { ticks++; }});
  stream.reset([{pitch: 60, start: 0, duration: 4}], {bpm: 60, end: 4});
  stream.progress.accept([note(60, 0.25)], 0, 0.5);
  stream.total = 16000;
  stream.pending = true;
  stream.feed(new Float32Array(1024));
  assert.equal(stream.progress.time, 1.064);
  assert.equal(ticks, 1);
  stream.pause();
  assert.equal(stream.progress.time, 1.064);
  assert.equal(stream.progress.complete, false);
});

test('timed reading rejects missing or impossible duration information', () => {
  assert.throws(() => new ReadingProgress(target(60), {bpm: 60, end: 4}));
  assert.throws(() => new ReadingProgress([{pitch: 60, start: 0, duration: 8}], {bpm: 60, end: 4}));
});

test('song following jumps to a passage played elsewhere and forgives the presses that found it', () => {
  const progress = new ReadingProgress(target(60, 62, 64, 65, 67, 69, 71, 72), {locate: true});
  progress.accept([note(60, 0.3)], 0, 1);
  assert.deepEqual([...progress.results], [[0, true]]);
  progress.accept([note(67, 1.0), note(69, 1.5), note(71, 2.0)], 0, 3);
  assert.equal(progress.index, 7);
  assert.equal(progress.mistakes.size, 0);
  assert.deepEqual(progress.wrong, []);
  assert.deepEqual([...progress.results.keys()].sort(), [0, 4, 5, 6]);
  progress.accept([note(72, 2.5)], 0, 3);
  assert.ok(progress.complete);
});

test('song following prefers the nearest repeat and ordinary reading never relocates', () => {
  const repeated = target(60, 62, 64, 50, 60, 62, 64, 52);
  const song = new ReadingProgress(repeated, {locate: true});
  song.jump(7);
  song.accept([note(60, 0.3), note(62, 0.8), note(64, 1.3)], 0, 2);
  assert.equal(song.index, 7, 'the repeat at bar two is nearer than the opening');
  assert.equal(song.mistakes.size, 0);
  const reading = new ReadingProgress(target(60, 62, 64, 65, 67, 69, 71, 72));
  reading.accept([note(67, 1.0), note(69, 1.5), note(71, 2.0)], 0, 3);
  assert.equal(reading.index, 0);
  assert.deepEqual(reading.wrong, [71]);
  assert.throws(() => song.jump(99));
});
