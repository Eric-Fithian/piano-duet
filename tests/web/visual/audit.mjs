// Runs in the page: finds unreadable or clipped text in what is currently visible.
export function auditPage() {
  const problems = [];
  const parse = value => {
    // matches rgb()/rgba() with comma- or space-separated channels and optional alpha
    const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
    if (!match) return null;
    const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
    return [+match[1], +match[2], +match[3], alpha];
  };
  const over = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const luminance = rgb => {
    const [r, g, b] = rgb.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const background = element => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none' && !style.backgroundImage.startsWith('url(')) return null;
      const color = parse(style.backgroundColor);
      if (color && color[3] > 0) { layers.push(color); if (color[3] >= 1) break; }
    }
    let result = [255, 255, 255, 1];
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0) return false;
      if (node.tagName === 'DETAILS' && !node.open && !element.closest('summary')) return false;
    }
    const dialog = document.querySelector('dialog[open]');
    if (dialog && !dialog.contains(element)) return false;
    return true;
  };
  const name = element => (element.id ? `#${element.id}` : element.className ? `.${String(element.className).split(' ')[0]}` : element.tagName.toLowerCase());
  for (const element of document.querySelectorAll('body *')) {
    if (element.closest('svg, #sheetMusic svg, script, style, noscript')) continue;
    const text = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
    const control = element.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), select');
    if (!text && !control) continue;
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const hidden = node => { const st = getComputedStyle(node); return st.clipPath === 'inset(50%)' || (node.getBoundingClientRect().width <= 1 && st.overflow === 'hidden'); };
    let concealed = false;
    for (let node = element; node; node = node.parentElement) if (hidden(node)) concealed = true;
    if (concealed || parseFloat(style.fontSize) === 0) continue;
    const label = `${name(element)} "${(text || element.value || element.placeholder || '').slice(0, 40)}"`;
    const bg = background(element);
    const fg = parse(style.color);
    if (bg && fg) {
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) opacity *= +getComputedStyle(node).opacity;
      const shown = over([...fg.slice(0, 3), fg[3] * opacity], bg);
      const size = parseFloat(style.fontSize), bold = +style.fontWeight >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const disabled = element.closest(':disabled, [aria-disabled=true]');
      const need = disabled ? 0 : large ? 3 : 4.5;
      const value = ratio(shown, bg);
      if (value < need) problems.push(`contrast ${value.toFixed(2)} < ${need}: ${label}`);
      if (disabled && value < 2) problems.push(`disabled control almost invisible (${value.toFixed(2)}): ${label}`);
      if (size < 12 && !element.closest('.score-flow')) problems.push(`text ${size}px < 12px: ${label}`);
    }
    if (text && !control && (style.whiteSpace !== 'normal' || ['hidden', 'clip'].includes(style.overflowX))) {
      if (element.scrollWidth > element.clientWidth + 1 && style.textOverflow !== 'ellipsis' && element.clientWidth) problems.push(`text clipped: ${label}`);
    }
    if (text) {
      const rect = element.getBoundingClientRect();
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const ps = getComputedStyle(parent);
        if (['auto', 'scroll'].includes(ps.overflowY) || ['auto', 'scroll'].includes(ps.overflowX) || parent.tagName === 'DIALOG') break;
        const bordered = parseFloat(ps.borderTopWidth) > 0 && parseFloat(ps.borderLeftWidth) > 0;
        if (!bordered) continue;
        const box = parent.getBoundingClientRect();
        if (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1) problems.push(`text escapes its box ${name(parent)}: ${label}`);
        break;
      }
    }
  }
  const labels = [...document.querySelectorAll('button, [role=button], summary, a[href]')].filter(visible)
    .map(element => (element.getAttribute('aria-label') || element.textContent).trim()).filter(Boolean);
  const counts = labels.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map());
  for (const [value, count] of counts) if (count > 1) problems.push(`duplicate visible control "${value}" x${count}`);
  return [...new Set(problems)];
}
