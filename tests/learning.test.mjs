import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LearningCycle} from '../src/piano_duet/static/learning.mjs';

test('a learning round goes from idea to imitation to score, then accepts a new idea', () => {
  const cycle = new LearningCycle();
  cycle.beginIdea('round-a');
  cycle.acceptLesson({id: 'round-a', notes: [{pitch:60,start:0,duration:1,velocity:80}], analysis: []});
  assert.equal(cycle.stage, 'repeat');
  cycle.acceptScore({score:97});
  assert.equal(cycle.stage, 'idea');
  assert.equal(cycle.result.score, 97);
  cycle.beginIdea('round-b');
  assert.equal(cycle.result, null);
  assert.equal(cycle.target.length, 0);
});

test('reset invalidates pending targets and late responses', () => {
  const cycle = new LearningCycle();
  cycle.beginIdea('round-a');
  cycle.reset();
  assert.throws(() => cycle.acceptLesson({id:'round-a',notes:[{pitch:60}],analysis:[]}));
  assert.throws(() => cycle.acceptScore({score:100}));
});
