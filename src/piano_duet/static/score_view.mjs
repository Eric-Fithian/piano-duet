// The one score viewer used throughout the app. Engraving, layout and following are shared; each part of the app
// turns on the layers it needs (a cursor, note feedback, the notes you played, a playhead, a tempo guide) through
// a profile, and the player chooses how to see the music: wrapped lines or one long line, zoom, how far to look
// ahead and how the view follows along.
import {estimateTempo, spellPitch} from './notation.mjs';
import {engrave} from './engraving.mjs';

export const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
// Where the music being played sits along the reading direction: lower values leave more of the score ahead.
export const LOOKAHEAD = {less: 0.45, normal: 0.25, more: 0.06};
export const LAYOUTS = ['wrap', 'line'];
export const FOLLOWS = ['smooth', 'page', 'off'];
const PREFERENCES = {layout: 'wrap', zoom: 1, lookahead: 'normal', follow: 'smooth'};
const FEATURES = {
  scale: 1, cursor: false, feedback: false, heard: false, pace: false, sounding: false, focus: false,
  headings: false, maxBars: null, barNumbers: 'systems', followNewest: false,
  settings: ['layout', 'zoom', 'lookahead', 'follow'], defaults: {}, empty: null,
};
const PADDING = 12;
const SVG = 'http://www.w3.org/2000/svg';

export function readingMark(phrase, index, seconds = null) {
  if (seconds !== null) {
    const tick = seconds * phrase.bpm / 60 * phrase.engraved.ticksPerBeat;
    const sounding = phrase.marks.filter(mark => mark.start <= tick && mark.end > tick);
    const mark = sounding.find(mark => mark.ids.includes(index))
      || sounding.find(mark => mark.ids.length && mark.ids.every(id => id <= index))
      || sounding.find(mark => !mark.ids.length);
    if (mark) return mark;
  }
  return phrase.marks.find(mark => mark.ids.includes(index));
}

export function paceX(points, tick) {
  if (tick <= points[0].tick) return points[0].x;
  const next = points.findIndex(point => point.tick > tick);
  if (next === -1) return points.at(-1).x;
  const [a, b] = [points[next - 1], points[next]];
  return a.x + (b.x - a.x) * (tick - a.tick) / (b.tick - a.tick);
}

export function pacePoints(phrase, system) {
  const marks = phrase.marks.filter(mark => mark.system === system).sort((a, b) => a.start - b.start);
  const points = [];
  for (const mark of marks) {
    if (points.at(-1)?.tick !== mark.start) points.push({tick: mark.start, x: mark.note.getAbsoluteX() + 7});
  }
  const stave = marks.at(-1).note.getStave();
  points.push({tick: Math.max(...marks.map(mark => mark.end)), x: stave.getX() + stave.getWidth() - 8});
  return points;
}

// The scroll offset that puts `position` at `anchor` of the viewport, never scrolling past either end.
export function followOffset(position, anchor, viewport, content) {
  return Math.max(0, Math.min(Math.max(0, content - viewport), position - anchor * viewport));
}

// Page turning keeps the view still until the music in play leaves it, then turns so it starts near the edge.
export function pageOffset(start, end, offset, viewport, content, margin) {
  if (start >= offset + margin && end <= offset + viewport - margin) return offset;
  return followOffset(start - margin, 0, viewport, content);
}

// The system and horizontal position (in staff units) of the music at `tick`.
export function focusAt(phrase, tick) {
  const starts = phrase.systems.map((_, system) => Math.min(...phrase.marks.filter(mark => mark.system === system).map(mark => mark.start)));
  const system = Math.max(0, starts.findLastIndex(start => start <= tick));
  return {system, x: paceX(pacePoints(phrase, system), tick)};
}

function element(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.append(node);
  return node;
}

function shape(parent, tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  parent.append(node);
  return node;
}

export class ScoreView {
  constructor(container) {
    this.container = container;
    this.container.classList.add('score-view');
    this.scroller = element('div', 'score-scroller', container);
    this.scroller.tabIndex = 0;
    this.flow = element('div', 'score-flow', this.scroller);
    this.options = {tempo: 'auto', bpm: 120, meter: '4/4', flats: null};
    this.profile = {...FEATURES};
    this.name = null;
    this.preferences = {...PREFERENCES};
    this.phrases = [];
    this.pending = new Set();
    this.timer = null;
    this.onRender = () => {};
    this.onError = error => { throw error; };
    this.paused = false;
    this.motion = null;
    this.width = 0;
    this.buildControls();
    this.clear();
    // Scrolling by hand pauses following until the player resumes it or the music moves on to another line.
    for (const type of ['wheel', 'touchmove']) {
      this.scroller.addEventListener(type, event => { if (!(type === 'wheel' && event.ctrlKey)) this.pause(); }, {passive: true});
    }
    this.scroller.addEventListener('keydown', event => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) this.pause();
    });
    this.scroller.addEventListener('scroll', () => this.pinHeaders(), {passive: true});
    // A pinch on a trackpad arrives as a wheel event with ctrlKey; it zooms the music, not the page.
    let pinch = 0;
    this.scroller.addEventListener('wheel', event => {
      if (!event.ctrlKey || !this.profile.settings.includes('zoom')) return;
      event.preventDefault();
      pinch += event.deltaY;
      if (Math.abs(pinch) < 40) return;
      this.step(pinch < 0 ? 1 : -1);
      pinch = 0;
    }, {passive: false});
    this.observer = new ResizeObserver(() => {
      const width = this.scroller.clientWidth;
      if (!width) return;
      if (width !== this.width && this.preferences.layout === 'wrap') for (const phrase of this.phrases) this.schedule(phrase);
      this.width = width;
      this.refollow(true);
    });
    this.observer.observe(this.scroller);
  }

  async ready() {
    if (!window.VexFlow) throw new Error('The local sheet-music library is missing. Run piano-duet setup.');
    await document.fonts.ready;
    for (const family of ['Bravura', 'Academico']) {
      const faces = [...document.fonts].filter(font => font.family === family);
      if (!faces.length || faces.some(font => font.status !== 'loaded')) throw new Error(`Sheet music font ${family} could not load.`);
    }
  }

  // Each part of the app has its own profile and remembers the player's own way of viewing it.
  use(name, profile) {
    this.name = name;
    this.profile = {...FEATURES, ...profile};
    const saved = JSON.parse(localStorage.getItem(`piano-duet.view.${profile.preferences || name}`) || '{}');
    this.preferences = {...PREFERENCES, ...this.profile.defaults, ...saved};
    if (!ZOOMS.includes(this.preferences.zoom)) this.preferences.zoom = 1;
    this.clear();
  }

  set(changes) {
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'zoom' && !ZOOMS.includes(value)) throw new Error(`Zoom must be one of ${ZOOMS.join(', ')}.`);
      if (key === 'layout' && !LAYOUTS.includes(value)) throw new Error(`Unknown score layout ${value}.`);
      if (key === 'follow' && !FOLLOWS.includes(value)) throw new Error(`Unknown follow mode ${value}.`);
      if (key === 'lookahead' && !(value in LOOKAHEAD)) throw new Error(`Unknown look-ahead ${value}.`);
    }
    const before = this.preferences;
    this.preferences = {...before, ...changes};
    localStorage.setItem(`piano-duet.view.${this.profile.preferences || this.name}`, JSON.stringify(this.preferences));
    this.resume(false);
    if (before.layout !== this.preferences.layout || (before.zoom !== this.preferences.zoom && this.preferences.layout === 'wrap')) {
      for (const phrase of this.phrases) this.schedule(phrase);
    } else if (before.zoom !== this.preferences.zoom) {
      for (const phrase of this.phrases) this.size(phrase);
      this.refollow(true);
    } else this.refollow();
    this.showControls();
  }

  step(direction) {
    const zoom = ZOOMS[ZOOMS.indexOf(this.preferences.zoom) + direction];
    if (zoom !== undefined) this.set({zoom});
  }

  get scale() {
    return this.profile.scale * this.preferences.zoom;
  }

  configure(options) {
    this.options = {...this.options, ...options};
    for (const phrase of this.phrases) this.schedule(phrase);
  }

  heard(notes, key, {kind = 'you', label = null} = {}) {
    this.playback(null);
    this.playing = null;
    if (!notes.length) return;
    this.add(kind, notes, {bpm: estimateTempo(notes), key, title: label});
  }

  reply(note, {kind = 'duet', label = null} = {}) {
    if (!this.playing) {
      const heard = this.phrases.at(-1);
      this.playing = this.add(kind, [], {bpm: heard?.bpm || 120, key: heard?.key, title: label});
    }
    this.playing.notes.push({...note});
    this.schedule(this.playing);
  }

  add(kind, notes, details = {}) {
    this.flow.querySelector('.sheet-empty, .score-message')?.remove();
    const article = element('article', `score-phrase ${kind}`);
    this.flow.insertBefore(article, this.placeholder?.isConnected ? this.placeholder : null);
    const title = details.title || `${kind === 'you' ? 'You' : 'Duet'} · ${Math.floor(this.phrases.length / 2) + 1}`;
    const heading = element('header', 'score-heading', article);
    heading.hidden = !this.profile.headings;
    element('h2', '', heading).textContent = title;
    const label = element('span', '', heading);
    const systems = element('div', 'score-systems', article);
    systems.setAttribute('role', 'img');
    const phrase = {kind, notes: notes.map(note => ({...note})), bpm: 120, meter: null, key: null, clef: null, exact: false, bars: 0,
      final: false, ...details, title, article, label, host: systems, marks: [], systems: null};
    this.phrases.push(phrase);
    this.schedule(phrase);
    if (this.profile.followNewest) this.focus = {phrase, system: 0, x: 0};
    return phrase;
  }

  update(phrase, changes) {
    Object.assign(phrase, changes);
    this.schedule(phrase);
  }

  remove(phrase) {
    this.pending.delete(phrase);
    const before = phrase.article.offsetTop + phrase.article.offsetHeight;
    const across = phrase.article.offsetLeft + phrase.article.offsetWidth;
    const above = this.preferences.layout === 'wrap' ? phrase.article.offsetTop < this.scroller.scrollTop : phrase.article.offsetLeft < this.scroller.scrollLeft;
    this.phrases = this.phrases.filter(item => item !== phrase);
    if (this.playing === phrase) this.playing = null;
    if (this.focus?.phrase === phrase) this.focus = null;
    phrase.article.remove();
    // Removing music the player has already passed must not move what they are looking at.
    if (above && this.preferences.layout === 'wrap') this.scroller.scrollTop -= before;
    else if (above) this.scroller.scrollLeft -= across;
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.phrases = [];
    this.playing = null;
    this.focus = null;
    this.reading = null;
    this.pace = null;
    this.paceAnchor = null;
    this.cursorAt = null;
    this.motion = null;
    if (this.resumeButton) this.resume(false);
    this.flow.replaceChildren();
    this.placeholder = null;
    this.pulse?.remove();
    this.pulse = null;
    this.applyLayout();
    if (this.profile.empty) {
      const empty = element('div', 'sheet-empty', this.flow);
      empty.innerHTML = this.profile.empty;
    }
    this.showControls();
  }

  // A short note in place of the music, such as "find the notes yourself".
  message(text) {
    this.clear();
    this.flow.querySelector('.sheet-empty')?.remove();
    element('p', 'score-message', this.flow).textContent = text;
  }

  applyLayout() {
    this.container.dataset.layout = this.preferences.layout;
    this.flow.className = `score-flow score-flow-${this.preferences.layout}`;
  }

  schedule(phrase) {
    this.pending.add(phrase);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = [...this.pending];
      this.pending.clear();
      this.applyLayout();
      for (const current of pending) {
        if (!this.phrases.includes(current) || !current.notes.length || !this.scroller.clientWidth) continue;
        try { this.render(current); } catch (error) { this.onError(error); }
      }
      this.showControls();
      this.refollow(true);
      this.onRender();
    }, 60);
  }

  render(phrase) {
    const target = phrase.kind === 'target';
    const bpm = target || this.options.tempo === 'auto' ? phrase.bpm : this.options.bpm;
    const meter = target ? (phrase.meter || '4/4') : this.options.meter;
    const wrap = this.preferences.layout === 'wrap';
    const width = wrap ? Math.max(260, (this.scroller.clientWidth - 2 * PADDING) / this.scale) : null;
    const engraved = engrave({...phrase, bpm, meter, flats: this.options.flats ?? phrase.flats}, phrase.host,
      {width, maxBars: this.profile.maxBars, barNumbers: this.profile.barNumbers, reserveCursor: this.profile.cursor});
    phrase.engraved = engraved;
    phrase.marks = engraved.marks;
    phrase.systems = engraved.systems;
    phrase.engravedBpm = bpm;
    engraved.systems.forEach((system, index) => {
      system.element.dataset.system = index;
      system.phrase = phrase;
    });
    this.size(phrase);
    const key = phrase.key ? `${phrase.key.name} · ` : '';
    const staves = phrase.clef && phrase.clef !== 'grand' ? `the ${phrase.clef} staff` : 'treble and bass staves';
    phrase.label.textContent = `${key}♩ = ${bpm}${this.options.tempo === 'auto' && !target ? ' estimated' : ''} · ${engraved.model.meter} · ${phrase.notes.length} notes`;
    phrase.host.setAttribute('aria-label', `${phrase.title}: ${key}${phrase.notes.length} notes on ${staves}, ${engraved.model.meter}.`);
    if (phrase.state) this.applyReading();
    if (phrase.selected) this.highlight(phrase, phrase.selected);
    this.applyFocus();
  }

  // Drawn size: the profile's staff size times the player's zoom, shrunk only if a line would not fit across.
  size(phrase) {
    if (!phrase.systems) return;
    const header = phrase.engraved.header;
    if (header) {
      header.svg.style.width = `${header.frame.width * this.scale}px`;
      header.svg.style.height = `${header.frame.height * this.scale}px`;
      header.element.style.marginRight = `${-header.frame.width * this.scale}px`;
      this.pinHeaders();
    }
    const available = this.scroller.clientWidth - 2 * PADDING;
    for (const system of phrase.systems) {
      const scale = this.preferences.layout === 'wrap' ? Math.min(this.scale, available / system.frame.width) : this.scale;
      system.scale = scale;
      system.svg.style.width = `${system.frame.width * scale}px`;
      system.svg.style.height = `${system.frame.height * scale}px`;
    }
  }

  // On one long line the clef and key are pinned only once the start of their line has scrolled away.
  pinHeaders() {
    if (this.preferences.layout !== 'line') return;
    const left = this.scroller.scrollLeft;
    for (const phrase of this.phrases) {
      const header = phrase.engraved?.header;
      if (header) header.element.classList.toggle('score-header-pinned', left > phrase.article.offsetLeft + 2);
    }
  }

  // Grows a system's frame to fit an overlay drawn outside it, such as a wrong note far above the staff.
  fit(system, low, high) {
    const top = Math.min(system.frame.top, low - 8);
    const bottom = Math.max(system.frame.top + system.frame.height, high + 8);
    if (top === system.frame.top && bottom === system.frame.top + system.frame.height) return;
    system.frame = {...system.frame, top, height: bottom - top};
    system.svg.setAttribute('viewBox', `0 ${top} ${system.frame.width} ${system.frame.height}`);
    system.svg.style.height = `${system.frame.height * system.scale}px`;
  }

  // --- Following -------------------------------------------------------------------------------------------

  focusOn(phrase, system, x) {
    const changed = this.focus?.phrase !== phrase || this.focus?.system !== system;
    this.focus = {phrase, system, x};
    if (changed) { this.applyFocus(); if (this.paused) this.resume(false); }
    this.refollow();
  }

  pause() {
    if (!this.focus || this.preferences.follow === 'off' || this.paused) return;
    this.paused = true;
    this.motion = null;
    this.resumeButton.hidden = false;
  }

  resume(follow = true) {
    this.paused = false;
    this.resumeButton.hidden = true;
    if (follow) this.refollow();
  }

  // Every system in reading order, across phrases.
  get lines() {
    return this.phrases.flatMap(phrase => phrase.systems || []);
  }

  applyFocus() {
    if (!this.profile.focus) return;
    const order = this.phrases.indexOf(this.focus?.phrase);
    this.phrases.forEach((phrase, index) => {
      for (const system of phrase.systems || []) {
        const place = order < 0 ? 0 : index - order || Number(system.element.dataset.system) - this.focus.system;
        system.element.classList.toggle('score-system-past', place < 0);
        system.element.classList.toggle('score-system-ahead', place > 0);
      }
    });
  }

  // Wrapped lines start moving toward the next line during the last part of the current one, so the view has
  // settled before the player arrives; turning shows the next line before the current one runs out.
  refollow(instant = false) {
    const focus = this.focus;
    if (!focus || this.preferences.follow === 'off' || this.paused) return;
    const system = focus.phrase.systems?.[focus.system];
    if (!system?.element.isConnected) return;
    const anchor = LOOKAHEAD[this.preferences.lookahead];
    const page = this.preferences.follow === 'page';
    if (this.preferences.layout === 'wrap') {
      const lines = this.lines;
      const next = lines[lines.indexOf(system) + 1];
      const start = system.element.offsetTop;
      const fraction = Math.min(1, Math.max(0, focus.x / system.frame.width));
      const blend = next ? Math.min(1, Math.max(0, (fraction - 0.7) / 0.3)) : 0;
      const viewport = this.scroller.clientHeight, content = this.scroller.scrollHeight;
      const end = next && fraction > 0.6 ? next.element.offsetTop + next.element.offsetHeight : start + system.element.offsetHeight;
      const target = page ? pageOffset(start, end, this.scroller.scrollTop, viewport, content, 8)
        : followOffset(start + blend * ((next?.element.offsetTop ?? start) - start) - 8, anchor, viewport, content);
      this.glide('scrollTop', target, instant);
    } else {
      const x = system.element.offsetLeft + focus.x * system.scale;
      const viewport = this.scroller.clientWidth, content = this.scroller.scrollWidth;
      const target = page ? pageOffset(x, x + viewport * 0.2, this.scroller.scrollLeft, viewport, content, viewport * 0.06)
        : followOffset(x, anchor, viewport, content);
      this.glide('scrollLeft', target, instant);
    }
  }

  // Eases the scroll position toward its target; reduced-motion settings move it at once.
  glide(axis, target, instant) {
    if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.motion = null;
      this.scroller[axis] = target;
      return;
    }
    const running = this.motion;
    this.motion = {axis, target};
    if (running) return;
    let last = performance.now();
    const frame = now => {
      const motion = this.motion;
      if (!motion) return;
      const current = this.scroller[motion.axis];
      const step = (motion.target - current) * Math.min(1, (now - last) / 140);
      last = now;
      if (Math.abs(motion.target - current) < 1) {
        this.scroller[motion.axis] = motion.target;
        this.motion = null;
        return;
      }
      this.scroller[motion.axis] = current + step;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // Follows written time without drawing a cursor, as drills do while the player plays.
  follow(phrase, seconds) {
    if (!phrase?.systems || !phrase.marks.length) return;
    const {system, x} = focusAt(phrase, seconds * phrase.engravedBpm / 60 * phrase.engraved.ticksPerBeat);
    this.focusOn(phrase, system, x);
  }

  // Lights the notes sounding during playback and, when the profile says so, follows them.
  playback(seconds) {
    const phrase = this.playing;
    if (!phrase?.systems) return;
    const origin = phrase.notes.length ? Math.min(...phrase.notes.map(note => note.start)) : 0;
    const tick = seconds === null ? -1 : Math.floor((seconds - origin) * phrase.engravedBpm / 60 * phrase.engraved.ticksPerBeat);
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    for (const mark of phrase.marks) mark.element?.classList.toggle('score-sounding', this.profile.sounding && tick >= mark.start && tick < mark.end);
    if (seconds === null || this.reading || !phrase.marks.length) return;
    const {system, x} = focusAt(phrase, Math.max(0, tick));
    this.focusOn(phrase, system, x);
  }

  // --- Reading: cursor, feedback, the notes you played and the tempo guide ---------------------------------

  progress(phrase, progress, next = null) {
    if (!phrase) return;
    const previous = this.reading?.phrase;
    if (previous && previous !== phrase) {
      for (const system of previous.systems || []) system.svg.querySelector('.reading-overlay')?.remove();
      this.pace = null;
    }
    this.reading = {phrase, progress, next};
    phrase.state = progress;
    this.showPending(!next && !phrase.final ? 'Preparing the next score…' : null);
    if (phrase.systems) this.applyReading();
  }

  showPending(text) {
    if (!text) { this.placeholder?.remove(); this.placeholder = null; return; }
    if (!this.placeholder) {
      this.placeholder = element('p', 'score-pending');
      this.placeholder.setAttribute('role', 'status');
    }
    this.placeholder.textContent = text;
    if (!this.placeholder.isConnected) this.flow.append(this.placeholder);
  }

  applyReading() {
    const {phrase, progress} = this.reading || {};
    if (!phrase?.systems || phrase.state !== progress) return;
    const index = progress.displayIndex;
    const timing = progress.wrong.length ? null : progress.timing;
    const seconds = timing?.scoreTime ?? null;
    const tick = timing ? timing.scoreTime * phrase.bpm / 60 * phrase.engraved.ticksPerBeat : null;
    const active = progress.attacks?.find(attack => attack.indices[0] === index)?.indices || [index];
    const current = readingMark(phrase, index, seconds);
    this.cursorMark = current;
    for (const mark of phrase.marks) {
      const selected = mark === current || (mark.ids.some(id => active.includes(id))
        && (tick === null ? !mark.tiedIds.some(id => active.includes(id)) : mark.start <= tick && mark.end > tick));
      mark.current = selected;
      if (!this.profile.feedback) continue;
      mark.element?.classList.toggle('score-read-done', !progress.preview && mark.ids.length && mark.ids.every(id => id < progress.index));
      mark.element?.classList.toggle('score-read-missed', mark.ids.some(id => progress.mistakes.has(id)));
    }
    for (const system of phrase.systems) system.svg.querySelector('.reading-overlay')?.remove();
    if (!current) return;
    const system = phrase.systems[current.system];
    const overlay = shape(system.svg, 'g', {class: 'reading-overlay'});
    if (this.profile.cursor) this.drawCursor(phrase, current, overlay);
    if (this.profile.heard) {
      const extent = this.drawHeard(phrase, current, overlay, progress.wrong);
      if (extent) this.fit(system, ...extent);
    }
    if (this.profile.pace && progress.bpm !== null) this.drawPace(phrase, current.system, overlay);
    else this.pace = null;
    this.focusOn(phrase, current.system, current.note.getAbsoluteX());
    this.tick(progress);
  }

  // One baseline per staff keeps the cursor below every stem and beam on its line as it moves.
  drawCursor(phrase, current, overlay) {
    const cursors = shape(overlay, 'g', {class: 'reading-cursor'});
    let x = null;
    for (const mark of phrase.marks.filter(item => item.current && item.system === current.system)) {
      const stave = mark.note.getStave();
      const bottom = Math.max(stave.getYForLine(4), ...phrase.marks
        .filter(other => other.system === current.system && other.note.getStave() === stave)
        .map(other => { const box = other.note.getBoundingBox(); return box.getY() + box.getH(); }));
      x = mark.note.getAbsoluteX() + 7;
      shape(cursors, 'rect', {x: x - 10, y: bottom + 9, width: 20, height: 3.5, rx: 1.75});
    }
    const at = {phrase, system: current.system, x};
    const last = this.cursorAt;
    if (last && last.phrase === phrase && last.system === at.system && last.x !== at.x && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cursors.animate([{transform: `translateX(${last.x - at.x}px)`}, {transform: 'none'}], {duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)'});
    }
    this.cursorAt = at;
  }

  // The wrong notes the player is holding, drawn in red beside the note they should play.
  drawHeard(phrase, current, overlay, wrong) {
    let extent = null;
    for (const pitch of wrong) {
      const clef = phrase.clef && phrase.clef !== 'grand' ? phrase.clef : pitch < 60 ? 'bass' : 'treble';
      const stave = current.staves[clef];
      const spelling = spellPitch(pitch, false, phrase.key);
      const note = new window.VexFlow.StaveNote({clef, keys: [spelling.key], duration: 'q'}).setStave(stave);
      const y = note.getYs()[0];
      const x = current.note.getAbsoluteX() + 23;
      const top = stave.getYForLine(0), bottom = stave.getYForLine(4);
      extent = [Math.min(extent?.[0] ?? Infinity, y - 30), Math.max(extent?.[1] ?? -Infinity, y + 6)];
      for (let line = top - 10; line >= y - 1; line -= 10) shape(overlay, 'line', {x1: x - 9, x2: x + 9, y1: line, y2: line, class: 'score-heard'});
      for (let line = bottom + 10; line <= y + 1; line += 10) shape(overlay, 'line', {x1: x - 9, x2: x + 9, y1: line, y2: line, class: 'score-heard'});
      shape(overlay, 'ellipse', {cx: x, cy: y, rx: 6, ry: 4, class: 'score-heard', transform: `rotate(-20 ${x} ${y})`});
      shape(overlay, 'line', {x1: x + 5, x2: x + 5, y1: y, y2: y - 28, class: 'score-heard', 'stroke-width': 1.5});
      if (spelling.accidental !== 'n') {
        shape(overlay, 'text', {x: x - 20, y: y + 5, class: 'score-heard', 'font-size': 17}).textContent = spelling.accidental.replaceAll('#', '♯').replaceAll('b', '♭');
      }
    }
    return extent;
  }

  drawPace(phrase, system, overlay) {
    const staves = phrase.marks.filter(mark => mark.system === system).map(mark => mark.note.getStave());
    const top = Math.min(...staves.map(stave => stave.getYForLine(0))) - 14;
    const bottom = Math.max(...staves.map(stave => stave.getYForLine(4))) + 14;
    const head = shape(overlay, 'g', {class: 'reading-pace'});
    shape(head, 'rect', {x: -9, y: top, width: 18, height: bottom - top, rx: 9, class: 'reading-pace-band'});
    shape(head, 'rect', {x: -1, y: top, width: 2, height: bottom - top, rx: 1, class: 'reading-pace-line'});
    overlay.prepend(head);
    this.pace = {key: `${phrase.id}:${system}`, phrase, system, head, points: pacePoints(phrase, system)};
  }

  // Called every frame while reading: moves the tempo guide and the hold count, and the cursor when it changes.
  tick(progress) {
    const phrase = this.reading?.phrase;
    if (phrase?.systems && this.reading.progress === progress) {
      const mark = readingMark(phrase, progress.displayIndex, progress.wrong.length ? null : progress.timing?.scoreTime ?? null);
      if (mark && mark !== this.cursorMark) { this.applyReading(); return; }
    }
    this.movePace(progress);
    this.showPulse(progress);
  }

  // The playhead starts at the line's first played note and then follows the written tempo.
  movePace(progress) {
    const pace = this.pace;
    if (!pace) return;
    const active = progress.active;
    const mark = active && pace.phrase === this.reading?.phrase && pace.phrase.marks.find(item => item.ids.includes(active.index));
    if (mark?.system === pace.system && this.paceAnchor?.key !== pace.key) {
      this.paceAnchor = {key: pace.key, onset: active.start, scoreStart: active.scoreStart};
    }
    const anchor = this.paceAnchor?.key === pace.key ? this.paceAnchor : null;
    pace.head.style.visibility = anchor ? 'visible' : 'hidden';
    if (!anchor) return;
    const seconds = anchor.scoreStart + (progress.time - anchor.onset) * progress.rate;
    const tick = seconds * pace.phrase.bpm / 60 * pace.phrase.engraved.ticksPerBeat;
    pace.head.setAttribute('transform', `translate(${paceX(pace.points, tick)} 0)`);
  }

  // The tempo and the count of a held note or rest, in the corner of the music.
  showPulse(progress) {
    if (!this.profile.pace || progress.bpm === null) { this.pulse?.remove(); this.pulse = null; return; }
    if (!this.pulse) {
      this.pulse = element('div', 'score-pulse', this.container);
      element('span', 'reading-count', this.pulse);
      const track = element('span', 'reading-beat-track', this.pulse);
      track.setAttribute('aria-hidden', 'true');
      element('span', '', track);
    }
    const timing = progress.timing;
    let text = `♩ = ${progress.tempo}`;
    if (timing) {
      const start = timing.resting ? timing.release : timing.start;
      const end = timing.resting ? timing.until : timing.release;
      const beats = Math.round((end - start) * progress.tempo / 60 * 100) / 100;
      const beat = Math.min(Math.ceil(beats), Math.floor((progress.time - start) * progress.tempo / 60) + 1);
      const count = beats >= 1 ? `${beat} / ${beats}` : `${beats} beat`;
      text = `${timing.resting ? 'Rest' : 'Hold'} · ${count} · ${text}`;
    }
    const label = this.pulse.firstElementChild;
    if (label.textContent !== text) label.textContent = text;
    const track = this.pulse.lastElementChild;
    track.hidden = !timing;
    track.firstElementChild.style.transform = `scaleX(${timing?.fraction ?? 0})`;
  }

  // --- Editing ----------------------------------------------------------------------------------------------

  // The phrase, system and score coordinates under a pointer event, or null off the music.
  hit(event) {
    const node = event.target.closest?.('.score-system');
    const phrase = node && this.phrases.find(item => item.systems?.some(system => system.element === node));
    if (!phrase) return null;
    const system = Number(node.dataset.system);
    const svg = phrase.systems[system].svg;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return {phrase, system, point: point.matrixTransform(svg.getScreenCTM().inverse())};
  }

  // The written note whose head is nearest the point, within about a notehead's width.
  noteAt({phrase, system, point}) {
    let best = null;
    for (const mark of phrase.marks.filter(item => item.system === system)) {
      mark.ids.forEach((id, index) => {
        const head = mark.note.noteHeads[index];
        const distance = Math.hypot(head.getAbsoluteX() + head.getWidth() / 2 - point.x, mark.note.getYs()[index] - point.y);
        if (distance <= 8 && (!best || distance < best.distance)) best = {id, distance};
      });
    }
    return best?.id ?? null;
  }

  // The staff, line or space and score tick under the point, for adding a note there. Ticks are interpolated
  // between the written attacks of that line and rounded to the sixteenth grid.
  placeAt({phrase, system, point}) {
    const marks = phrase.marks.filter(mark => mark.system === system);
    if (!marks.length) return null;
    const distance = stave => Math.abs(point.y - stave.getYForLine(2));
    const [clef, stave] = Object.entries(marks[0].staves).filter(([name]) => !phrase.clef || phrase.clef === 'grand' || name === phrase.clef)
      .reduce((best, item) => (distance(item[1]) < distance(best[1]) ? item : best));
    const steps = Math.round((point.y - stave.getYForLine(0)) / (stave.getSpacingBetweenLines() / 2));
    const points = pacePoints(phrase, system);
    let tick = points[0].tick;
    for (let i = 1; i < points.length; i++) {
      if (point.x >= points[i - 1].x) {
        const a = points[i - 1], b = points[i];
        tick = a.tick + Math.min(1, (point.x - a.x) / Math.max(1, b.x - a.x)) * (b.tick - a.tick);
      }
    }
    const grid = phrase.engraved.ticksPerBeat / 4;
    return {clef, steps, system, tick: Math.min(points.at(-1).tick - grid, Math.round(tick / grid) * grid)};
  }

  highlight(phrase, ids) {
    phrase.selected = ids;
    for (const system of phrase.systems || []) {
      system.svg.querySelector('.edit-selection')?.remove();
      const overlay = shape(system.svg, 'g', {class: 'edit-selection'});
      for (const mark of phrase.marks.filter(item => item.system === Number(system.element.dataset.system))) {
        mark.ids.forEach((id, index) => {
          if (!ids.includes(id)) return;
          const head = mark.note.noteHeads[index];
          shape(overlay, 'ellipse', {cx: head.getAbsoluteX() + head.getWidth() / 2, cy: mark.note.getYs()[index], rx: 10, ry: 7});
        });
      }
    }
  }

  // --- The player's view controls --------------------------------------------------------------------------

  buildControls() {
    const controls = element('div', 'score-controls', this.container);
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Score view');
    const button = (label, text, action) => {
      const node = element('button', '', controls);
      node.type = 'button';
      node.setAttribute('aria-label', label);
      node.textContent = text;
      node.addEventListener('click', action);
      return node;
    };
    this.zoomOut = button('Zoom out', '−', () => this.step(-1));
    this.zoomLabel = element('span', 'score-zoom', controls);
    this.zoomIn = button('Zoom in', '+', () => this.step(1));
    this.menuButton = button('View options', '', () => this.toggleMenu());
    this.menuButton.className = 'score-menu-button';
    this.menuButton.setAttribute('aria-haspopup', 'true');
    this.menuButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h16"/></svg>';
    this.resumeButton = element('button', 'score-resume', this.container);
    this.resumeButton.type = 'button';
    this.resumeButton.textContent = 'Resume following';
    this.resumeButton.hidden = true;
    this.resumeButton.addEventListener('click', () => this.resume());
    this.menu = element('div', 'score-menu', this.container);
    this.menu.hidden = true;
    this.menu.setAttribute('role', 'dialog');
    this.menu.setAttribute('aria-label', 'Score view options');
    const choices = [
      ['layout', 'Layout', [['wrap', 'Lines', 'Lines wrap down the page'], ['line', 'One line', 'One long line that scrolls sideways']]],
      ['follow', 'Follow along', [['smooth', 'Glide', 'Glide to keep the music in view'], ['page', 'Turn', 'Turn when the music reaches the edge'], ['off', 'Off', 'Scroll yourself']]],
      ['lookahead', 'Look ahead', [['less', 'Less', 'More of what you just played'], ['normal', 'Some', 'A balance'], ['more', 'More', 'As much upcoming music as fits']]],
    ];
    this.rows = {};
    for (const [key, title, options] of choices) {
      const row = element('div', 'score-menu-row', this.menu);
      element('span', 'score-menu-title', row).textContent = title;
      const group = element('div', 'score-menu-choices', row);
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', title);
      for (const [value, label, description] of options) {
        const choice = element('button', '', group);
        choice.type = 'button';
        choice.dataset.value = value;
        choice.textContent = label;
        choice.title = description;
        choice.setAttribute('role', 'radio');
        choice.addEventListener('click', () => this.set({[key]: value}));
      }
      this.rows[key] = row;
    }
    document.addEventListener('pointerdown', event => {
      if (!this.menu.hidden && !this.menu.contains(event.target) && !this.menuButton.contains(event.target)) this.toggleMenu(false);
    });
    this.menu.addEventListener('keydown', event => { if (event.key === 'Escape') { this.toggleMenu(false); this.menuButton.focus(); } });
    this.controls = controls;
  }

  toggleMenu(open = this.menu.hidden) {
    this.menu.hidden = !open;
    this.menuButton.setAttribute('aria-expanded', open);
    if (open) this.menu.querySelector('[aria-checked=true]')?.focus();
  }

  showControls() {
    if (!this.controls) return;
    const settings = this.profile.settings;
    this.controls.hidden = !settings.length || !this.phrases.some(phrase => phrase.notes.length);
    const zoom = settings.includes('zoom');
    for (const node of [this.zoomOut, this.zoomLabel, this.zoomIn]) node.hidden = !zoom;
    this.zoomLabel.textContent = `${Math.round(this.preferences.zoom * 100)}%`;
    this.zoomOut.disabled = this.preferences.zoom === ZOOMS[0];
    this.zoomIn.disabled = this.preferences.zoom === ZOOMS.at(-1);
    const menu = settings.filter(key => key !== 'zoom');
    this.menuButton.hidden = !menu.length;
    if (this.controls.hidden || !menu.length) this.toggleMenu(false);
    for (const [key, row] of Object.entries(this.rows)) {
      row.hidden = !menu.includes(key);
      for (const choice of row.querySelectorAll('button')) choice.setAttribute('aria-checked', choice.dataset.value === this.preferences[key]);
    }
    // Look-ahead means nothing when the view does not follow.
    this.rows.lookahead.classList.toggle('score-menu-muted', this.preferences.follow === 'off');
  }
}
