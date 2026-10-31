import assert from 'node:assert/strict';
import test from 'node:test';
import {levelRing, resultSummary, stagePath, stageWindow, streakBeam} from '../src/piano_duet/static/progress_components.mjs';

class Node {
  constructor(tag) { this.tag = tag; this.attributes = {}; this.children = []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...nodes) { this.children.push(...nodes); }
}
globalThis.document = {createElementNS: (_, tag) => new Node(tag)};
const path = Array.from({length: 24}, (_, index) => ({number: index + 1, label: `Stage ${index + 1}`, status: index < 6 ? 'Complete' : index === 6 ? 'Current' : 'Ahead'}));

test('stage path is a five-stage window with checks only on earned stages', () => {
  assert.deepEqual(stageWindow(path, 7).map(stage => stage.number), [6, 7, 8, 9, 10]);
  assert.deepEqual(stageWindow(path, 24).map(stage => stage.number), [20, 21, 22, 23, 24]);
  const svg = stagePath(path, 7);
  assert.ok(svg.attributes['aria-label'].startsWith('Stages 6 to 10 of 24. Stage 6 complete, Stage 7 current'));
  assert.ok(svg.attributes['aria-label'].includes('Stage 10 locked'));
  assert.equal(svg.children.filter(node => node.tag === 'g' && node.children.length === 2).length, 1);
  assert.throws(() => stageWindow(path, 25));
});

test('XP ring and unbroken beam reflect the separate reward tracks', () => {
  assert.equal(levelRing({into: 100, needed: 400}).children[1].attributes['stroke-dasharray'], '25 100');
  assert.throws(() => levelRing({into: 401, needed: 400}));
  assert.equal(streakBeam(1).children.filter(node => node.tag === 'ellipse').length, 1);
  assert.equal(streakBeam(3).children.filter(node => node.tag === 'ellipse').length, 3);
  assert.equal(streakBeam(9).children.filter(node => node.tag === 'ellipse').length, 4);
  assert.equal(streakBeam(99).children.filter(node => node.tag === 'ellipse').length, 4);
});

test('a stage is celebrated only when evidence clears it, and XP includes stage rewards', () => {
  const before = {curriculum: {path: path.map(stage => ({...stage, status: stage.number === 7 ? 'Current' : stage.status})), number: 7}, xp: {xp: 400}};
  const after = {curriculum: {path: path.map(stage => ({...stage, status: stage.number === 7 ? 'Complete' : stage.status})), number: 8}, xp: {xp: 1100}};
  const task = {reading: {stage_number: 7}};
  const result = {assessment: {score: {first_try: 15, total: 16}, observations: [{matched: false, expected: 60, tries: [[62], [60]]}]}, xp: {total: 100}};
  const summary = resultSummary(task, result, before, after);
  assert.equal(summary.title, 'Stage 7 complete');
  assert.equal(summary.milestone, true);
  assert.equal(summary.detail, '15 of 16 notes first try · Next: Stage 8');
  assert.equal(summary.xp, 700);
  assert.equal(summary.mistake.expected, 60);
  assert.equal(resultSummary(task, result, after, after).title, 'Score complete');
  assert.equal(resultSummary(task, result, after, after).milestone, false);
  after.curriculum.path[7].groups = [{hand: 'treble', samples: 1, required: 3, ready: false}];
  assert.ok(resultSummary({reading: {stage_number: 8}}, result, after, after).detail.includes('2 more fresh right-hand scores'));
});

test('a stage-clear result includes the bonus in ordinary XP text', () => {
  const before = {curriculum: {number: 1, path: path.map(stage => ({...stage, status: stage.number === 1 ? 'Current' : 'Ahead'}))}, xp: {xp: 600}};
  const after = {curriculum: {number: 2, path: path.map(stage => ({...stage, status: stage.number === 1 ? 'Complete' : stage.number === 2 ? 'Current' : 'Ahead'}))}, xp: {xp: 1107}};
  const result = {assessment: {score: {first_try: 15, total: 16}, observations: [{matched: false, expected: 60, tries: [[62], [60]]}]}, xp: {total: 207}};
  assert.equal(resultSummary({reading: {stage_number: 1}}, result, before, after).xp, 507);
});
