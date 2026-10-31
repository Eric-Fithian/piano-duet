import test from 'node:test';
import assert from 'node:assert/strict';
import {naturalWidth, planSystems} from '../src/piano_duet/static/engraving.mjs';
import {LOOKAHEAD, MIN_FIT_SCALE, fitScale, focusAt, followOffset, paceX, pageOffset, readingMark} from '../src/piano_duet/static/score_view.mjs';

const widths = (lines, bars) => lines.map(([start, end]) => bars.slice(start, end).reduce((sum, value) => sum + value, 0));

test('fit uses both page dimensions and never shrinks below readable staff spacing', () => {
  const measure = scale => ({width: 200 * scale, height: 100 * scale});
  assert.ok(Math.abs(fitScale(measure, 500, 180) - 1.8) < 0.02);
  assert.ok(Math.abs(fitScale(measure, 400, 500) - 2) < 0.02);
  assert.equal(fitScale(measure, 200, 100), MIN_FIT_SCALE);
});

test('fit preserves the most bars per line before increasing staff size', () => {
  const measure = scale => ({width: 300, height: 100 * scale, breaks: scale < 1.7 ? '2,2' : '1,2,1'});
  assert.ok(Math.abs(fitScale(measure, 400, 600) - 1.7) < 0.02);
});

test('lines are as few as the width allows and balanced so the last is not a stub', () => {
  const bars = [200, 200, 200, 200];
  assert.deepEqual(planSystems(bars, 700), [[0, 2], [2, 4]]);
  assert.deepEqual(planSystems(bars, 900), [[0, 4]]);
  // Filling greedily would give 3, 4, 4 and a stub of 2 bars.
  const song = Array(13).fill(180);
  const lines = planSystems(song, 820, {first: 110, rest: 85});
  assert.deepEqual(lines.map(([start, end]) => end - start).sort(), [3, 3, 3, 4]);
  assert.ok(Math.max(...widths(lines, song)) - Math.min(...widths(lines, song)) <= 180);
  assert.equal(planSystems(song, 800, {first: 110, rest: 85}).length, 5);
});

test('every bar is placed once, in order, and a bar wider than the line gets a line of its own', () => {
  const bars = [120, 900, 130, 140, 150];
  const lines = planSystems(bars, 500);
  assert.deepEqual(lines.flatMap(([start, end]) => Array.from({length: end - start}, (_, i) => start + i)), [0, 1, 2, 3, 4]);
  assert.ok(lines.some(([start, end]) => start === 1 && end === 2));
  assert.deepEqual(planSystems([], 500), []);
});

test('a bar limit caps each line without changing the order', () => {
  assert.deepEqual(planSystems(Array(6).fill(50), 2000, {maxBars: 4}), [[0, 3], [3, 6]]);
  assert.ok(naturalWidth(10) >= 150 && naturalWidth(400) > 400);
});

test('following puts the music at the look-ahead point without scrolling past the ends', () => {
  assert.equal(followOffset(500, LOOKAHEAD.normal, 400, 2000), 400);
  assert.equal(followOffset(50, LOOKAHEAD.normal, 400, 2000), 0);
  assert.equal(followOffset(1990, LOOKAHEAD.more, 400, 2000), 1600);
  assert.equal(followOffset(300, 0, 400, 300), 0);
  assert.ok(LOOKAHEAD.more < LOOKAHEAD.normal && LOOKAHEAD.normal < LOOKAHEAD.less);
});

test('page turning stays still while the music is visible and turns before it runs out', () => {
  assert.equal(pageOffset(100, 300, 0, 400, 2000, 8), 0);
  assert.equal(pageOffset(300, 450, 0, 400, 2000, 8), 292);
  assert.equal(pageOffset(50, 150, 200, 400, 2000, 8), 42);
  assert.equal(pageOffset(1900, 1990, 0, 400, 2000, 8), 1600);
});

const stave = {getX: () => 0, getWidth: () => 400};
const mark = (system, start, end, x, ids = [0]) => ({system, start, end, ids, note: {getAbsoluteX: () => x, getStave: () => stave}});

test('the focus is the line holding the written time and the position along it', () => {
  const phrase = {systems: [{}, {}], marks: [mark(0, 0, 4, 93), mark(0, 4, 8, 193), mark(1, 8, 12, 93), mark(1, 12, 16, 193)]};
  assert.deepEqual(focusAt(phrase, 0), {system: 0, x: 100});
  assert.deepEqual(focusAt(phrase, 2), {system: 0, x: 150});
  assert.deepEqual(focusAt(phrase, 10), {system: 1, x: 150});
  assert.deepEqual(focusAt(phrase, 99), {system: 1, x: 392});
});

test('timed reading follows tied notes and rests across lines', () => {
  const phrase = {bpm: 60, engraved: {ticksPerBeat: 4}, marks: [
    {system: 0, ids: [0], start: 0, end: 16},
    {system: 1, ids: [0], start: 16, end: 24},
    {system: 1, ids: [], start: 24, end: 32},
  ]};
  assert.equal(readingMark(phrase, 0, 3).system, 0);
  assert.equal(readingMark(phrase, 0, 4).system, 1);
  assert.deepEqual(readingMark(phrase, 0, 6).ids, []);
  assert.equal(readingMark(phrase, 0).system, 0);
});

test('a sustained voice stays highlighted when the last short note has ended', () => {
  const phrase = {bpm: 60, engraved: {ticksPerBeat: 4}, marks: [
    {system: 0, ids: [], start: 8, end: 16},
    {system: 0, ids: [0], start: 0, end: 16},
    {system: 0, ids: [1], start: 4, end: 8},
  ]};
  assert.deepEqual(readingMark(phrase, 1, 3).ids, [0]);
});

test('the pace playhead moves linearly between written onsets and stops at the end of the line', () => {
  const points = [{tick: 0, x: 100}, {tick: 12, x: 160}, {tick: 18, x: 200}, {tick: 48, x: 500}];
  assert.equal(paceX(points, -4), 100);
  assert.equal(paceX(points, 6), 130);
  assert.equal(paceX(points, 12), 160);
  assert.equal(paceX(points, 33), 350);
  assert.equal(paceX(points, 60), 500);
});
