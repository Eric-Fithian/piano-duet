import {pitchName} from './learning.mjs';
import {spellPitch} from './notation.mjs';

export function landingAppearance(stats) {
  if (!stats?.samples) return {color: '#9ba39c', measured: false, opacity: 1};
  const amount = Math.max(0, Math.min(1, (stats.arrival_seconds - 0.5) / 2.5));
  const stops = [[56, 132, 130], [211, 168, 78], [184, 86, 65]];
  const start = amount < 0.5 ? stops[0] : stops[1];
  const end = amount < 0.5 ? stops[1] : stops[2];
  const blend = amount < 0.5 ? amount * 2 : (amount - 0.5) * 2;
  return {color: `rgb(${start.map((value, i) => Math.round(value + blend * (end[i] - value))).join(', ')})`, measured: true, opacity: stats.samples < 3 ? 0.5 : 1};
}

export function landingDescription(pitch, stats) {
  const name = pitchName(pitch);
  const outliers = stats?.outliers ? ` · ${stats.outliers} outlier${stats.outliers === 1 ? '' : 's'} excluded` : '';
  if (!stats?.samples) return `${name} · No usable landing times yet${outliers}.`;
  return `${name} · ${stats.arrival_seconds.toFixed(2)} s to land · ${stats.samples} landing${stats.samples === 1 ? '' : 's'}${stats.samples < 3 ? ' · Early estimate' : ''}${outliers}.`;
}

export function renderLandingHeatmap(container, hands) {
  container.replaceChildren();
  const {Renderer, Stave, StaveNote} = window.VexFlow;
  for (const clef of ['treble', 'bass']) {
    const hand = hands[clef];
    const figure = document.createElement('figure');
    figure.className = 'landing-map';
    const caption = document.createElement('figcaption');
    caption.textContent = clef === 'treble' ? 'Treble · Right hand' : 'Bass · Left hand';
    const canvas = document.createElement('div');
    canvas.className = 'landing-staff';
    const detail = document.createElement('p');
    detail.className = 'landing-detail';
    detail.setAttribute('aria-live', 'polite');
    detail.textContent = 'Select a note for its timing.';
    figure.append(caption, canvas, detail);
    container.append(figure);
    const allPitches = Object.keys(hand.pitches).map(Number).sort((a, b) => a - b);
    const render = pitches => {
      canvas.replaceChildren();
      const renderer = new Renderer(canvas, Renderer.Backends.SVG);
      const context = renderer.getContext();
      context.setFillStyle('#33463b');
      context.setStrokeStyle('#33463b');
      const reference = new Stave(10, 16, 380);
      const ys = pitches.map(pitch => new StaveNote({clef, keys: [spellPitch(pitch).key], duration: 'q'}).setStave(reference).getYs()[0]);
      const top = Math.max(0, 30 - Math.min(...ys));
      const labelY = Math.max(136, Math.max(...ys) + top + 25);
      const height = labelY + 24;
      renderer.resize(400, height);
      const stave = new Stave(10, 16 + top, 380).addClef(clef).setContext(context);
      stave.draw();
      const svg = canvas.querySelector('svg');
      svg.setAttribute('viewBox', `0 0 400 ${height}`);
      svg.setAttribute('pointer-events', 'auto');
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', `${clef === 'treble' ? 'Treble' : 'Bass'} clef: recent time to reach each position-change note`);
      for (let i = 0; i < pitches.length; i++) {
        const pitch = pitches[i];
        const stats = hand.fluency.landings.find(row => row.pitch === pitch);
        const {color, measured, opacity} = landingAppearance(stats);
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'landing-note');
        group.setAttribute('role', 'button');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-label', landingDescription(pitch, stats));
        group.setAttribute('aria-pressed', 'false');
        const x = 70 + i * 304 / Math.max(1, pitches.length - 1);
        const note = new StaveNote({clef, keys: [spellPitch(pitch, false).key], duration: 'q'}).setStave(stave);
        const y = note.getYs()[0];
        const shape = (tag, attributes, text) => {
          const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
          for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
          if (text !== undefined) node.textContent = text;
          group.append(node);
          return node;
      };
      shape('title', {}, landingDescription(pitch, stats));
      shape('rect', {x: x - 13, y: 24, width: 26, height: height - 28, rx: 6, class: 'landing-hit'});
      shape('ellipse', {cx: x, cy: y, rx: 16, ry: 16, fill: color, opacity: measured ? 0.25 * opacity : 0.1});
      for (let line = stave.getYForLine(0) - 10; line >= y - 1; line -= 10) {
        shape('line', {x1: x - 12, x2: x + 12, y1: line, y2: line, stroke: '#33463b'});
      }
      for (let line = stave.getYForLine(4) + 10; line <= y + 1; line += 10) {
        shape('line', {x1: x - 12, x2: x + 12, y1: line, y2: line, stroke: '#33463b'});
      }
      shape('ellipse', {cx: x, cy: y, rx: 8, ry: 5.5, fill: color, 'fill-opacity': opacity, stroke: '#33463b', 'stroke-width': 0.8, transform: `rotate(-20 ${x} ${y})`});
      if (spellPitch(pitch).accidental === '#') shape('text', {x: x - 17, y: y + 5, fill: '#33463b', 'font-size': 14}, '♯');
      shape('text', {x, y: labelY, class: 'landing-label'}, pitchName(pitch));
      shape('text', {x, y: labelY + 16, class: 'landing-value'}, stats?.samples ? `${stats.arrival_seconds.toFixed(1)}s` : '—');
      const select = () => {
        for (const other of svg.querySelectorAll('.landing-note')) other.setAttribute('aria-pressed', 'false');
        group.setAttribute('aria-pressed', 'true');
        detail.textContent = landingDescription(pitch, stats);
      };
      group.addEventListener('click', select);
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
      });
      svg.append(group);
    }
    };
    const needsRange = allPitches.length > 12 || allPitches[0] < (clef === 'bass' ? 36 : 60) || allPitches.at(-1) > (clef === 'bass' ? 60 : 84);
    if (needsRange) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${clef === 'bass' ? 'Bass' : 'Treble'} landing-map octave`);
      for (const octave of [...new Set(allPitches.map(pitch => Math.floor(pitch / 12) - 1))]) {
        const option = document.createElement('option');
        option.value = octave; option.textContent = `Octave ${octave} · C${octave}–B${octave}`;
        select.append(option);
      }
      select.value = String(clef === 'bass' ? 3 : 4);
      const update = () => {
        render(allPitches.filter(pitch => Math.floor(pitch / 12) - 1 === Number(select.value)));
        detail.textContent = 'Select a note for its timing.';
      };
      select.addEventListener('change', update);
      figure.insertBefore(select, canvas);
      update();
    } else render(allPitches);
  }
}
