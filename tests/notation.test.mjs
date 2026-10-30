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

test('exact reading preserves rests, explicit staves, and trailing empty bars', () => {
  const score = createScore([{...note(60, .5, .25), staff: 'bass'}, note(62, 1, 1)], {bpm: 60, exact: true, bars: 2});
  assert.equal(score.bars.length, 2);
  assert.equal(score.bars[0].bass[0].notes.length, 0);
  assert.equal(score.quantized[0].staff, 'bass');
  assert.equal(score.quantized[0].start, 6);
  assert.equal(score.quantized[0].end, 9);
  assert.ok(score.bars[1].bass.every(part => !part.notes.length));
});

test('triplets retain three equal attacks and all time signatures fill exactly', () => {
  for (const meter of ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8']) {
    const score = createScore([note(60, 0, 1/3), note(62, 1/3, 1/3), note(64, 2/3, 1/3)], {bpm: 60, meter, exact: true, bars: 2});
    assert.deepEqual(score.bars[0].treble.slice(0, 3).map(part => [part.value, part.tuplet, part.ticks]), [['8', 3, 4], ['8', 3, 4], ['8', 3, 4]]);
    for (const bar of score.bars) for (const staff of ['treble', 'bass']) {
      assert.equal(bar[staff].reduce((sum, part) => sum + part.ticks, 0), score.barTicks);
    }
  }
});

test('minor raised leading notes retain their letter, including double sharps', () => {
  const key = {mode: 'minor', tonic: 8, pitch_classes: [8, 10, 11, 1, 3, 4, 6], scale_names: ['G#', 'A#', 'B', 'C#', 'D#', 'E', 'F#']};
  assert.equal(spellPitch(67, false, key).key, 'f##/4');
  const cSharpMinor = {mode: 'minor', tonic: 1, pitch_classes: [1, 3, 4, 6, 8, 9, 11], scale_names: ['C#', 'D#', 'E', 'F#', 'G#', 'A', 'B']};
  assert.equal(spellPitch(60, false, cSharpMinor).key, 'b#/3');
});

test('a held note in one hand survives the same pitch attacked by the other hand', () => {
  const notes = [{pitch: 62, start: 0, duration: 4, velocity: 70, staff: 'bass'}, {pitch: 62, start: 1, duration: 1, velocity: 80, staff: 'treble'}];
  const [held, attack] = quantizeNotes(notes, 60, {exact: true, ticksPerBeat: 12});
  assert.deepEqual([held.staff, held.start, held.end], ['bass', 0, 48]);
  assert.deepEqual([attack.staff, attack.start, attack.end], ['treble', 12, 24]);
});

test('a held bass in a second voice is one written note under the moving voice, not a chain of ties', () => {
  const moving = [0, 1, 2].map(beat => ({pitch: 59, start: beat, duration: 1, velocity: 70, staff: 'bass'}));
  const held = {pitch: 40, start: 0, duration: 3, velocity: 70, staff: 'bass', voice: 1};
  const [bar] = createScore([...moving, held], {bpm: 60, meter: '3/4', exact: true, bars: 1}).bars;
  assert.deepEqual(bar.bass.map(part => [part.value, part.notes.map(n => n.pitch)]), [['q', [59]], ['q', [59]], ['q', [59]]]);
  assert.deepEqual(bar.second.bass.map(part => [part.value, part.dotted, part.notes.map(n => n.pitch)]), [['h', true, [40]]]);
  assert.equal(bar.second.treble, null);
});

test('a grace note takes no written time and joins the note it ornaments', () => {
  const notes = [note(72, 0, 0.5), {...note(78, 0.5, 0.125), grace: true}, note(79, 0.5, 1.5)];
  const score = createScore(notes, {bpm: 120, meter: '4/4', exact: true});
  const parts = score.bars[0].treble.filter(part => part.notes.length);
  assert.deepEqual(parts.map(part => part.notes.map(n => n.pitch)), [[72], [79]]);
  assert.deepEqual(parts[1].graces, [{pitch: 78, id: 1}]);
  assert.ok(score.quantized.every(n => n.pitch !== 78));
  assert.equal(score.bars[0].treble.reduce((sum, part) => sum + part.ticks, 0), score.barTicks);
});
