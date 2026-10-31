{
  const preference = localStorage.getItem('piano-duet-theme') ?? 'system';
  const night = localStorage.getItem('piano-duet-night-page') ?? 'false';
  if (!['system', 'light', 'dark'].includes(preference)) throw new Error(`Unknown appearance: ${preference}`);
  if (!['true', 'false'].includes(night)) throw new Error(`Unknown night page setting: ${night}`);
  const theme = preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.night = night;
  const color = document.getElementById('themeColor');
  color.content = color.dataset[theme];
}
