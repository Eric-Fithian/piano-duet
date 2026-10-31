import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupAppearance} from '../src/piano_duet/static/appearance.mjs';

function fixture(saved = {}) {
  const root = {dataset: {}};
  const theme = new EventTarget();
  const night = new EventTarget();
  const system = new EventTarget();
  system.matches = false;
  const values = new Map(Object.entries(saved));
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const appearance = setupAppearance({root, theme, night, storage, system});
  return {root, theme, night, system, values, appearance};
}

test('appearance follows the system and persists explicit choices', () => {
  const {root, theme, night, system, values} = fixture();
  assert.deepEqual(root.dataset, {theme: 'light', night: 'false'});
  system.matches = true;
  system.dispatchEvent(new Event('change'));
  assert.equal(root.dataset.theme, 'dark');
  theme.value = 'light';
  theme.dispatchEvent(new Event('change'));
  night.checked = true;
  night.dispatchEvent(new Event('change'));
  assert.deepEqual(root.dataset, {theme: 'light', night: 'true'});
  assert.equal(values.get('piano-duet-theme'), 'light');
  assert.equal(values.get('piano-duet-night-page'), 'true');
  assert.deepEqual(fixture(Object.fromEntries(values)).root.dataset, root.dataset);
});

test('system changes wait until the take is over', () => {
  const {root, theme, night, system, appearance} = fixture();
  appearance.setLocked(true);
  assert.equal(theme.disabled, true);
  assert.equal(night.disabled, true);
  system.matches = true;
  system.dispatchEvent(new Event('change'));
  assert.equal(root.dataset.theme, 'light');
  appearance.setLocked(false);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(theme.disabled, false);
});
