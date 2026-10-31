const THEME_KEY = 'piano-duet-theme';
const NIGHT_KEY = 'piano-duet-night-page';

export function setupAppearance({root, theme, night, themeColor, storage, system}) {
  const savedTheme = storage.getItem(THEME_KEY) ?? 'system';
  if (!['system', 'light', 'dark'].includes(savedTheme)) throw new Error(`Unknown appearance: ${savedTheme}`);
  const savedNight = storage.getItem(NIGHT_KEY) ?? 'false';
  if (!['true', 'false'].includes(savedNight)) throw new Error(`Unknown night page setting: ${savedNight}`);
  theme.value = savedTheme;
  night.checked = savedNight === 'true';
  let locked = false;
  const apply = () => {
    if (locked) return;
    root.dataset.theme = theme.value === 'system' ? (system.matches ? 'dark' : 'light') : theme.value;
    root.dataset.night = String(night.checked);
    themeColor.content = themeColor.dataset[root.dataset.theme];
  };
  theme.addEventListener('change', () => { storage.setItem(THEME_KEY, theme.value); apply(); });
  night.addEventListener('change', () => { storage.setItem(NIGHT_KEY, String(night.checked)); apply(); });
  system.addEventListener('change', apply);
  apply();
  return {
    setLocked(value) {
      locked = value;
      theme.disabled = value;
      night.disabled = value;
      if (!value) apply();
    },
  };
}
