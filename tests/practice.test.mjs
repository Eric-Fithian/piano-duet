import test from 'node:test';
import assert from 'node:assert/strict';
import {PracticeCycle, evidenceLabels, levelLabel} from '../src/piano_duet/static/practice.mjs';
import {pitchName} from '../src/piano_duet/static/learning.mjs';

test('ear practice waits for a listen and stops collecting after an assessed attempt', () => {
  const cycle = new PracticeCycle();
  cycle.acceptTask({id: 'exercise', family: 'ear', target: [{pitch: 60}], context: {hearings: 0, reveals: 0}});
  assert.equal(cycle.canPlay, false);
  assert.equal(cycle.visible, false);
  cycle.task.context.hearings = 1;
  assert.equal(cycle.canPlay, true);
  cycle.acceptAssessment({id: 'attempt', assessment: {score: {score: 90}}});
  assert.equal(cycle.canPlay, false);
  assert.equal(cycle.completed, true);
  assert.equal(cycle.visible, true);
});

test('empty audio keeps a task open and a new task clears prior evidence', () => {
  const cycle = new PracticeCycle();
  const task = {id: 'exercise', family: 'reading', target: [{pitch: 60}], context: {notation_visible: true}};
  cycle.acceptTask(task);
  cycle.acceptAssessment({id: 'empty', assessment: {score: null}});
  assert.equal(cycle.canPlay, true);
  cycle.excluded = true;
  cycle.acceptTask({...task, id: 'next'});
  assert.equal(cycle.result, null);
  assert.equal(cycle.attemptId, null);
  assert.equal(cycle.excluded, false);
});

test('untested is different from exploring and conditions do not duplicate skill labels', () => {
  assert.equal(levelLabel({level: null}), 'Untested');
  assert.equal(levelLabel({level: 0}), 'Exploring');
  assert.equal(levelLabel({level: 2}), 'Level 2');
  assert.deepEqual(evidenceLabels({evidence: [
    {facet: 'all', label: 'Scales'}, {facet: 'key:C', label: 'C major'}, {facet: 'all', label: 'Reading'},
  ]}), ['Scales', 'Reading']);
});

test('review labels use the same spelling and octave as the given key', () => {
  const key = {pitch_classes: [6, 8, 10, 11, 1, 3, 5], scale_names: ['Gb', 'Ab', 'Bb', 'Cb', 'Db', 'Eb', 'F']};
  assert.equal(pitchName(71, key), 'C♭5');
  assert.equal(pitchName(66, key), 'G♭4');
});
