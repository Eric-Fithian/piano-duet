import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedHands, allowedOctaves, heardAttacks, issueSummary, loudnessOutliers, meterState, planSession, playedGap, tempoBand, resolveChoices, streakText, takeEnded, tempoLabel} from '../src/piano_duet/static/drills.mjs';

const scale = {variants: ['major', 'melodic minor'], hands: ['right', 'left', 'together', 'contrary'], octaves: [1, 2, 3, 4], inversions: 0, practices: ['even', 'accent-3']};
const hanon = {variants: ['major'], hands: ['right', 'together'], octaves: [1, 2], inversions: 0, practices: ['even']};
const catalog = {drills: {scale, hanon}};
const sequence = values => { let index = 0; return () => values[index++ % values.length]; };

test('contrary motion is offered only where the drill defines it', () => {
  assert.deepEqual(allowedHands(scale, 'melodic minor'), ['right', 'left', 'together']);
  assert.deepEqual(allowedOctaves(scale, 'contrary'), [1, 2]);
  assert.equal(tempoLabel(4, 88), '♩ = 88 in sixteenths');
});

test('random choices are rolled each rep and fixed choices are kept', () => {
  const fixed = {drill: 'scale', variant: 'major', tonic: 3, hands: 'together', octaves: 2, inversion: 0, practice: 'even'};
  assert.deepEqual(resolveChoices(catalog, fixed, sequence([0.99])), fixed);
  const key = resolveChoices(catalog, {...fixed, tonic: 'random'}, sequence([0.5]));
  assert.equal(key.tonic, 6);
  assert.deepEqual({...key, tonic: 3}, fixed);
});

test('a random drill rolls any fixed choice it cannot take', () => {
  const choices = {drill: 'random', variant: 'melodic minor', tonic: 0, hands: 'contrary', octaves: 4, inversion: 0, practice: 'accent-3'};
  const result = resolveChoices(catalog, choices, sequence([0.99, 0, 0, 0.99, 0]));
  assert.equal(result.drill, 'hanon');
  assert.equal(result.variant, 'major');
  assert.ok(hanon.hands.includes(result.hands) && hanon.octaves.includes(result.octaves));
  assert.equal(result.practice, 'even');
});

test('a clean rep still says why nothing is listed', () => {
  assert.deepEqual(issueSummary({issues: []}), ['No pauses, rushes or missed notes stood out.']);
  assert.deepEqual(issueSummary({issues: ['Missed C4 in bar 1']}), ['Missed C4 in bar 1']);
});

test('sessions stay on a drill for at least five minutes or takes, in at most three blocks', () => {
  assert.deepEqual(planSession('minutes', 5), {kind: 'minutes', amount: 5, blocks: 1, per: 5});
  assert.deepEqual(planSession('minutes', 10), {kind: 'minutes', amount: 10, blocks: 2, per: 5});
  assert.deepEqual(planSession('minutes', 30), {kind: 'minutes', amount: 30, blocks: 3, per: 10});
  assert.equal(planSession('takes', 20).blocks, 3);
});

test('the streak counts consecutive clean reps at any tempo', () => {
  assert.equal(streakText({streak: 2}, 3), '2 of 3 clean in a row');
  assert.equal(streakText(null, 3), '0 of 3 clean in a row');
});

test('the score follows the attacks heard, at the player\'s own pace', async () => {
  const {attackPlan, followPosition} = await import('../src/piano_duet/static/drills.mjs');
  const chord = start => [60, 64, 67].map(pitch => ({pitch, start}));
  const plan = attackPlan({target: [...chord(0), ...chord(1), ...chord(2)], bpm: 60});
  assert.deepEqual(plan, {gap: 1, attacks: [0, 1, 2]});
  assert.equal(followPosition(plan, 0, 0, 1), 0);
  // Half a gap after the second attack, the page is halfway to the third.
  assert.equal(followPosition(plan, 2, 0.5, 1), 1.5);
  assert.equal(followPosition(plan, 9, 0, 1), 2);
});

test('a take ends soon after its attacks stop, at the player\'s own pace', () => {
  const plan = {gap: 0.5, attacks: Array.from({length: 20}, (_, i) => i * 0.5)};
  // Every attack heard: a little more than one of the player's gaps is enough, however long the last note rings.
  assert.equal(takeEnded(plan, 20, 0.5, 0.5), false);
  assert.equal(takeEnded(plan, 20, 0.63, 0.5), true);
  assert.equal(takeEnded(plan, 20, 0.39, 0.2), false);
  assert.equal(takeEnded(plan, 20, 0.41, 0.2), true);
  // Most attacks heard: a hesitation of a beat or so near the end does not cut the take off.
  assert.equal(takeEnded(plan, 17, 0.9, 0.5), false);
  assert.equal(takeEnded(plan, 17, 1.01, 0.5), true);
  assert.equal(takeEnded(plan, 15, 5, 0.5), false);
  // The spacing comes from the player's recent attacks once there are a few.
  assert.equal(playedGap(plan, [0]), 0.5);
  assert.equal(playedGap(plan, [0, 1, 2, 3]), 1);
  assert.ok(Math.abs(playedGap(plan, [0, 1, 2, 3, 3.3, 3.6, 3.9]) - 0.3) < 1e-9);
});

test('counted attacks far quieter than the played notes do not keep a take open', () => {
  const times = [0.2, 0.6, 1.0, 1.4, 1.8, 2.1, 2.3, 2.5];
  const strengths = [0.03, 0.025, 0.04, 0.03, 0.035, 0.004, 0.003, 0.005];
  assert.deepEqual(heardAttacks(times, strengths), [0.2, 0.6, 1.0, 1.4, 1.8]);
  assert.deepEqual(heardAttacks([], []), []);
  assert.deepEqual(heardAttacks([0.5], [0.001]), [0.5]);
});

test('the results show where the tempo drifted and which notes were uneven', () => {
  const rows = [120, 120, 121, 119, 122, 130, 138, 140, 141].map((tempo, index) => ({tempo, velocity: index === 4 ? 90 : 60}));
  const band = tempoBand(rows, 8);
  assert.equal(band.opening, 120);
  assert.equal(band.closing, 140);
  assert.ok(Math.abs(band.low - 110.4) < 1e-9 && Math.abs(band.high - 129.6) < 1e-9);
  assert.ok(band.min < band.low && band.max > 141);
  assert.equal(tempoBand(rows.slice(0, 2), 8), null);
  assert.deepEqual([...loudnessOutliers(rows)], [4]);
  assert.deepEqual([...loudnessOutliers(rows, true)], [], 'accent practice is meant to be uneven');
  assert.equal(meterState(90, 90), 'good');
  assert.equal(meterState(89, 90), 'short');
});
