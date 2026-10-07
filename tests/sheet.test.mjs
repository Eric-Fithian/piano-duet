import test from 'node:test';
import assert from 'node:assert/strict';
import {paginateSystems} from '../src/piano_duet/static/sheet.mjs';

const phrase = (rows, width = 900) => ({layout: {rows, rowHeight: 240, scoreWidth: width}});

test('pages cover every system of every phrase once, in order', () => {
  const phrases = [phrase(7), phrase(3)];
  const pages = paginateSystems(phrases, 916, 526);
  assert.deepEqual(pages.map(page => [phrases.indexOf(page.phrase), page.start, page.end]),
    [[0, 0, 2], [0, 2, 4], [0, 4, 6], [0, 6, 7], [1, 0, 2], [1, 2, 3]]);
});

test('compact viewports keep all systems accessible without scrolling', () => {
  const music = phrase(30);
  const pages = paginateSystems([music], 320, 100);
  assert.equal(pages.length, 30);
  assert.equal(pages.at(-1).end, 30);
  assert.ok(pages.every(page => page.end - page.start === 1));
});

test('unrendered streaming phrases wait for notes and resizing repaginates', () => {
  const music = phrase(5, 400);
  assert.deepEqual(paginateSystems([{}], 400, 300), []);
  assert.equal(paginateSystems([music], 416, 286).length, 5);
  assert.equal(paginateSystems([music], 416, 766).length, 2);
});
