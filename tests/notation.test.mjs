import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createScore, estimateTempo, quantizeNotes, spellPitch} from '../src/piano_duet/static/notation.mjs';

const note = (pitch, start, duration = 0.5) => ({pitch, start, duration, velocity: 80});

test('two-handed chord attacks align despite microphone timing jitter', () => {
  const played = [note(48, 0.5), note(60, 0.52), note(64, 0.53), note(67, 0.51)];
  const original = structuredClone(played);
  const score = createScore(played);
  assert.deepEqual(score.bars[0].treble[0].notes.map(n => n.pitch), [60, 64, 67]);
  assert.deepEqual(score.bars[0].bass[0].notes.map(n => n.pitch), [48]);
  assert.ok(score.quantized.every(n => n.start === 0 && n.end === 4));
  assert.deepEqual(played, original);
});

test('overlapping voices sustain with ties through changing chords and bar lines', () => {
  const score = createScore([note(60, 0, 3), note(64, 0.5, 0.5), note(67, 1.5, 1)]);
  const middleC = score.bars.flatMap(bar => bar.treble).flatMap(part => part.notes.filter(n => n.pitch === 60));
  assert.equal(middleC[0].tied, false);
  assert.ok(middleC.slice(1).every(n => n.tied));
  assert.ok(score.bars[1].treble[0].notes.find(n => n.pitch === 60).tied);
});

test('repeated attacks cut off the prior instance without tying the new attack', () => {
  const played = [note(60, 0, 1), note(60, 0.5, 0.5)];
  const quantized = quantizeNotes(played, 120);
  assert.equal(quantized[0].end, quantized[1].start);
  const parts = createScore(played).bars[0].treble.filter(part => part.notes.length);
  assert.deepEqual(parts.map(part => part.notes[0].tied), [false, false]);
});

test('rests fill both staves exactly in every supported meter', () => {
  for (const meter of ['4/4', '3/4', '6/8']) {
    const score = createScore([note(21, 0, 0.125), note(108, 2, 1)], {bpm: 120, meter});
    for (const bar of score.bars) {
      for (const staff of ['treble', 'bass']) {
        assert.equal(bar[staff].reduce((sum, part) => sum + part.ticks, 0), score.barTicks);
        assert.equal(bar[staff][0].start, bar.start);
        assert.equal(bar[staff].at(-1).end, bar.end);
      }
    }
  }
});

test('sixteenth-note quantization preserves a real gap but closes short articulation gaps', () => {
  const score = createScore([note(60, 0, 0.4), note(62, 0.5, 0.2), note(64, 1.5, 0.5)]);
  assert.equal(score.quantized[0].end, 4);
  assert.equal(score.quantized[1].end, 6);
  assert.ok(score.bars[0].treble.some(part => !part.notes.length && part.start === 6));
});

test('tempo estimate handles simultaneous chords and regular quarter-note pulses', () => {
  for (const bpm of [80, 100, 120, 150]) {
    const played = Array.from({length: 8}, (_, i) => [note(60, i * 60 / bpm), note(48, i * 60 / bpm + 0.02)]).flat();
    assert.ok(Math.abs(estimateTempo(played) - bpm) <= 1);
  }
  assert.equal(estimateTempo([note(60, 0)]), 120);
});

test('pitch spelling covers piano endpoints and selectable enharmonics', () => {
  assert.equal(spellPitch(21).key, 'a/0');
  assert.equal(spellPitch(108).key, 'c/8');
  assert.equal(spellPitch(61).key, 'c#/4');
  assert.equal(spellPitch(61, true).key, 'db/4');
  assert.throws(() => createScore([note(200, 0)]), error => error.message.includes('Invalid note'));
  assert.throws(() => createScore([note(60, 0)], {bpm: 0}), error => error.message.includes('tempo'));
});

test('key signature spellings preserve sounding pitch at octave boundaries', () => {
  const key = {pitch_classes: [6, 8, 10, 11, 1, 3, 5], scale_names: ['Gb', 'Ab', 'Bb', 'Cb', 'Db', 'Eb', 'F']};
  assert.equal(spellPitch(59, true, key).key, 'cb/4');
  assert.equal(spellPitch(71, false, key).key, 'cb/5');
  assert.equal(spellPitch(66, false, key).key, 'gb/4');
  assert.equal(spellPitch(60, true, key).key, 'c/4');
});
