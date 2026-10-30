import test from 'node:test';
import assert from 'node:assert/strict';
import {PracticeCycle, evidenceLabels, levelLabel, beatGroups} from '../src/piano_duet/static/practice.mjs';
import {pitchName} from '../src/piano_duet/static/learning.mjs';
import {landingAppearance, landingDescription} from '../src/piano_duet/static/reading_heatmap.mjs';

test('the count-in follows simple, compound, and asymmetric beat groups', () => {
  assert.deepEqual(beatGroups('3/4'), [1, 1, 1]);
  assert.deepEqual(beatGroups('6/8'), [1.5, 1.5]);
  assert.deepEqual(beatGroups('9/8'), [1.5, 1.5, 1.5]);
  assert.deepEqual(beatGroups('7/8'), [1, 1, 1.5]);
  assert.equal(beatGroups('5/4').reduce((a, b) => a + b), 5);
});

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

test('landing heat colors use a fixed timing scale and fade early estimates', () => {
  assert.equal(landingAppearance().measured, false);
  assert.equal(landingAppearance({samples: 0, arrival_seconds: null}).measured, false);
  assert.equal(landingAppearance({samples: 2, arrival_seconds: 5}).measured, true);
  assert.equal(landingAppearance({samples: 2, arrival_seconds: 5}).opacity, 0.5);
  const fast = landingAppearance({samples: 3, arrival_seconds: 0.5});
  const slow = landingAppearance({samples: 3, arrival_seconds: 3});
  assert.equal(fast.measured, true);
  assert.notEqual(fast.color, slow.color);
  assert.equal(landingAppearance({samples: 20, arrival_seconds: 7}).color, slow.color);
  assert.equal(landingAppearance({samples: 20, arrival_seconds: 0.1}).color, fast.color);
  assert.equal(fast.opacity, 1);
  assert.equal(landingAppearance({samples: 1, arrival_seconds: 0.5}).color, fast.color);
});

test('landing details show arrival time and label early estimates', () => {
  assert.equal(landingDescription(60), 'C4 · No usable landing times yet.');
  const stats = {samples: 2, arrival_seconds: 1.2, outliers: 1};
  assert.equal(landingDescription(48, stats), 'C3 · 1.20 s to land · 2 landings · Early estimate · 1 outlier excluded.');
  assert.equal(landingDescription(60, {samples: 0, arrival_seconds: null, outliers: 1}), 'C4 · No usable landing times yet · 1 outlier excluded.');
});
