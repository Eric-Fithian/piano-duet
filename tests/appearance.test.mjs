import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupAppearance} from '../src/piano_duet/static/appearance.mjs';

function fixture(saved = {}, systemDark = false) {
  const root = {dataset: {}};
  const theme = new EventTarget();
  const night = new EventTarget();
  const system = new EventTarget();
  system.matches = systemDark;
  const themeColor = {dataset: {light: '#f5f1e8', dark: '#14211a'}};
  const values = new Map(Object.entries(saved));
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const appearance = setupAppearance({root, theme, night, themeColor, storage, system});
  return {root, theme, night, themeColor, system, values, appearance};
}

test('appearance follows the system and persists explicit choices', () => {
  const {root, theme, night, themeColor, system, values} = fixture();
  assert.deepEqual(root.dataset, {theme: 'light', night: 'false'});
  assert.equal(themeColor.content, '#f5f1e8');
  system.matches = true;
  system.dispatchEvent(new Event('change'));
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(themeColor.content, '#14211a');
  theme.value = 'light';
  theme.dispatchEvent(new Event('change'));
  night.checked = true;
  night.dispatchEvent(new Event('change'));
  assert.deepEqual(root.dataset, {theme: 'light', night: 'true'});
  assert.equal(themeColor.content, '#f5f1e8');
  assert.equal(values.get('piano-duet-theme'), 'light');
  assert.equal(values.get('piano-duet-night-page'), 'true');
  assert.deepEqual(fixture(Object.fromEntries(values)).root.dataset, root.dataset);
});

test('an explicit appearance overrides the system on startup', () => {
  const light = fixture({'piano-duet-theme': 'light'}, true);
  assert.equal(light.root.dataset.theme, 'light');
  assert.equal(light.themeColor.content, '#f5f1e8');
  const dark = fixture({'piano-duet-theme': 'dark', 'piano-duet-night-page': 'true'});
  assert.deepEqual(dark.root.dataset, {theme: 'dark', night: 'true'});
  assert.equal(dark.themeColor.content, '#14211a');
});

test('system changes wait until the take is over', () => {
  const {root, theme, night, themeColor, system, appearance} = fixture();
  appearance.setLocked(true);
  assert.equal(theme.disabled, true);
  assert.equal(night.disabled, true);
  system.matches = true;
  system.dispatchEvent(new Event('change'));
  assert.equal(root.dataset.theme, 'light');
  assert.equal(themeColor.content, '#f5f1e8');
  appearance.setLocked(false);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(themeColor.content, '#14211a');
  assert.equal(theme.disabled, false);
});
