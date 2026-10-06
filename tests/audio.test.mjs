import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PhraseDetector, readEvents} from '../src/piano_duet/static/audio.mjs';

test('room noise never becomes a phrase', () => {
  const detector = new PhraseDetector({noise: 0.003});
  for (let i = 0; i < 100; i++) {
    assert.equal(detector.feed(new Float32Array(1024).fill(0.004)).phrase, undefined);
  }
  assert.equal(detector.active, false);
});

test('chords are kept together and finish after a pause', () => {
  const detector = new PhraseDetector({pause: 0.4});
  for (let i = 0; i < 8; i++) detector.feed(new Float32Array(1024).fill(0.1));
  for (let i = 0; i < 4; i++) assert.equal(detector.feed(new Float32Array(1024)).phrase, undefined);
  assert.equal(detector.active, true);
  let phrase;
  for (let i = 0; i < 3; i++) phrase = detector.feed(new Float32Array(1024)).phrase;
  assert.ok(phrase instanceof Float32Array);
  assert.equal(phrase.length, 15 * 1024);
  assert.equal(detector.active, false);
});

test('five minutes of playing stays open until the player asks for a reply', () => {
  const detector = new PhraseDetector();
  for (let i = 0; i < 5000; i++) {
    assert.equal(detector.feed(new Float32Array(1024).fill(0.1)).phrase, undefined);
  }
  assert.equal(detector.active, true);
  const phrase = detector.finish();
  assert.equal(phrase.length, 5000 * 1024);
  assert.equal(phrase[0], phrase.at(-1));
  assert.equal(detector.active, false);
});

test('manual replies preserve long rests inside the performance', () => {
  const detector = new PhraseDetector({autoReply: false});
  detector.feed(new Float32Array(16000).fill(0.1));
  for (let i = 0; i < 30; i++) {
    assert.equal(detector.feed(new Float32Array(16000)).phrase, undefined);
  }
  detector.feed(new Float32Array(16000).fill(0.2));
  const phrase = detector.finish();
  assert.equal(phrase.length, 32 * 16000);
  assert.equal(phrase[16000], 0);
  assert.ok(phrase.at(-1) > phrase[0]);
});

test('manual answer preserves the phrase and reset forgets it', () => {
  const detector = new PhraseDetector();
  detector.feed(new Float32Array(2000).fill(0.1));
  assert.equal(detector.finish().length, 2000);
  assert.equal(detector.finish(), null);
  detector.feed(new Float32Array(2000).fill(0.1));
  detector.reset();
  assert.equal(detector.finish(), null);
});

test('network chunks may divide JSON and coalesce multiple events', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({start(controller) {
    for (const part of ['{"type":"hea', 'rd"}\n{"type":"note"}\n{', '"type":"done"}']) controller.enqueue(encoder.encode(part));
    controller.close();
  }});
  const events = [];
  for await (const event of readEvents(stream)) events.push(event.type);
  assert.deepEqual(events, ['heard', 'note', 'done']);
});
