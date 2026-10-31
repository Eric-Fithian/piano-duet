import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {PhraseDetector, captureAllowed, capturePerformanceTime, readEvents} from '../src/piano_duet/static/audio.mjs';

test('late microphone chunks are gated by capture time across different audio clocks', () => {
  const timestamp = {contextTime: 12, performanceTime: 100000}, latency = 0.012;
  const before = capturePerformanceTime(12.1, timestamp, latency);
  const after = capturePerformanceTime(12.2, timestamp, latency);
  assert.ok(Math.abs(before - 100112) < 0.001);
  assert.ok(Math.abs(after - 100212) < 0.001);
  const delivered = [{samples: 'during playback', capturedAt: before, deliveredAt: 102000},
    {samples: 'after playback', capturedAt: after, deliveredAt: 102001}];
  assert.ok(delivered.every(chunk => chunk.deliveredAt > 100150));
  const accepted = delivered.filter(chunk => captureAllowed(chunk.capturedAt, 100150, 100140, false));
  assert.deepEqual(accepted.map(chunk => chunk.samples), ['after playback']);
  assert.equal(captureAllowed(after, 100150, 100220, false), false);
  assert.equal(captureAllowed(after, 100150, 100140, true), false);
  assert.throws(() => capturePerformanceTime(1, undefined, 0), {message: 'The microphone capture clock is unavailable.'});
});

test('the microphone worklet timestamps the start of each complete chunk', () => {
  const messages = [];
  let Capture;
  class AudioWorkletProcessor { constructor() { this.port = {postMessage: message => messages.push(message)}; } }
  const scope = {AudioWorkletProcessor, Float32Array, currentFrame: 0, sampleRate: 16000,
    registerProcessor: (_name, processor) => { Capture = processor; }};
  runInNewContext(readFileSync('src/piano_duet/static/capture.js', 'utf8'), scope);
  const worklet = new Capture();
  for (let block = 0; block < 16; block++) {
    scope.currentFrame = block * 128;
    worklet.process([[new Float32Array(128).fill(block)]]);
  }
  assert.deepEqual(messages.map(message => message.capturedAt), [0, 0.064]);
  assert.equal(messages[0].samples.length, 1024);
  assert.equal(messages[1].samples[0], 8);
});

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

test('the attack counter finds each piano-like note and merges a rolled chord', async () => {
  const {AttackCounter} = await import('../src/piano_duet/static/audio.mjs');
  const rate = 16000;
  // Overlapping decaying tones every 125 ms (sixteenths at ♩ = 120), then a chord rolled over 30 ms.
  const onsets = [...Array(12).keys()].map(i => 0.2 + i * 0.125);
  const chord = [1.9, 1.915, 1.93];
  const audio = new Float32Array(rate * 2.6);
  for (const [start, pitch] of [...onsets.map((t, i) => [t, 262 * 2 ** (i / 12)]), ...chord.map((t, i) => [t, 330 * 2 ** (i / 4)])]) {
    for (let n = Math.round(start * rate); n < audio.length; n++) {
      const t = n / rate - start;
      audio[n] += 0.2 * Math.exp(-t / 0.35) * Math.sin(2 * Math.PI * pitch * t);
    }
  }
  const counter = new AttackCounter();
  for (let i = 0; i < audio.length; i += 1024) counter.feed(audio.subarray(i, i + 1024), 0.005);
  assert.equal(counter.count, 13);
  assert.ok(Math.abs(counter.times[0] - 0.2) < 0.02);
});

test('soft playing counts the same attacks as loud playing, and room noise counts none', async () => {
  const {AttackCounter} = await import('../src/piano_duet/static/audio.mjs');
  const rate = 16000;
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const take = (amplitude, noise) => {
    const audio = new Float32Array(rate * 4);
    for (let i = 0; i < audio.length; i++) audio[i] = noise * random();
    for (const [index, start] of [...Array(10).keys()].map(i => [i, 1.2 + i * 0.25])) {
      for (let n = Math.round(start * rate); n < audio.length; n++) {
        const t = n / rate - start;
        audio[n] += amplitude * Math.exp(-t / 0.4) * Math.sin(2 * Math.PI * 262 * 2 ** (index / 12) * t);
      }
    }
    const counter = new AttackCounter();
    for (let i = 0; i < audio.length; i += 1024) counter.feed(audio.subarray(i, i + 1024), Math.max(0.004, noise * 3 / Math.sqrt(3)));
    return counter.times;
  };
  for (const amplitude of [0.3, 0.03]) {
    const times = take(amplitude, 0.002);
    assert.equal(times.length, 10, `amplitude ${amplitude}`);
    assert.ok(times.every(time => time > 1.1), 'nothing is counted in the second of room noise before playing');
  }
  assert.equal(take(0, 0.004).length, 0);
});

test('legato steps in the low register count once each', async () => {
  const {AttackCounter} = await import('../src/piano_duet/static/audio.mjs');
  const rate = 16000;
  // C3 D3 E3 F3 G3 F3 E3 D3 C3, each held into the next, with partials falling off as a piano's do.
  const pitches = [48, 50, 52, 53, 55, 53, 52, 50, 48];
  const audio = new Float32Array(rate * 7);
  pitches.forEach((pitch, index) => {
    const start = 0.3 + index * 0.45, frequency = 440 * 2 ** ((pitch - 69) / 12);
    for (let n = Math.round(start * rate); n < Math.min(audio.length, Math.round((start + 0.7) * rate)); n++) {
      const t = n / rate - start;
      // Each note rises over 15 ms, as a hammer brings it in, and the damper releases it over 50 ms: without
      // these, a sudden start or stop clicks across every frequency and is easy to find anywhere.
      const release = Math.min(1, t / 0.015, (0.7 - t) / 0.05);
      for (let harmonic = 1; harmonic <= 8; harmonic++) audio[n] += 0.02 / harmonic * release * Math.exp(-t / 2) * Math.sin(2 * Math.PI * frequency * harmonic * t);
    }
  });
  const counter = new AttackCounter();
  for (let i = 0; i < audio.length; i += 1024) counter.feed(audio.subarray(i, i + 1024), 0.004);
  assert.equal(counter.count, 9);
  counter.times.forEach((time, index) => assert.ok(Math.abs(time - (0.3 + index * 0.45)) < 0.05));
});

test('the microphone waits while the app\'s own piano or clicks are sounding', async () => {
  const {PianoSound} = await import('../src/piano_duet/static/audio.mjs');
  const node = () => ({connect: target => target ?? node(), disconnect() {}, gain: {value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}},
    threshold: {value: 0}, ratio: {value: 0}, playbackRate: {value: 1}, start() {}, stop() {}});
  const context = {currentTime: 0, destination: node(), createGain: node, createDynamicsCompressor: node, createBufferSource: node};
  const piano = new PianoSound(context);
  piano.samples = [{pitch: 60, buffer: {}}];
  assert.equal(piano.audible, false);
  piano.play({pitch: 60, duration: 1, velocity: 80}, 2);
  context.currentTime = 3.5;
  assert.equal(piano.audible, true, 'the room still rings just after the note ends');
  context.currentTime = 3.8;
  assert.equal(piano.audible, false);
  piano.sound(5);
  assert.equal(piano.audible, true);
  piano.stop();
  context.currentTime = 4.4;
  assert.equal(piano.audible, false, 'stopping playback frees the microphone after the echo');
});

test('a grace note sounds briefly just before the beat it is written on', async () => {
  const {PianoSound} = await import('../src/piano_duet/static/audio.mjs');
  const started = [];
  const node = () => ({connect: target => target ?? node(), disconnect() {}, gain: {value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}},
    threshold: {value: 0}, ratio: {value: 0}, playbackRate: {value: 1}, start(when) { started.push(when); }, stop() {}});
  const context = {currentTime: 0, destination: node(), createGain: node, createDynamicsCompressor: node, createBufferSource: node};
  const piano = new PianoSound(context);
  piano.samples = [{pitch: 60, buffer: {}}];
  piano.play({pitch: 61, duration: 0.25, velocity: 80, grace: true}, 2);
  assert.ok(started[0] < 2 && started[0] > 1.9);
  assert.ok(piano.until < 2 + 0.25, 'the grace note is held only for its short lead, not its written length');
  piano.play({pitch: 62, duration: 1, velocity: 80}, 2);
  assert.equal(started[1], 2);
});
