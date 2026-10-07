import {createScore, estimateTempo, spellPitch} from './notation.mjs';

export function paginateSystems(phrases, width, height) {
  return phrases.flatMap(phrase => {
    if (!phrase.layout) return [];
    const {rows, rowHeight, scoreWidth} = phrase.layout;
    const scale = Math.min(1, Math.max(1, width - 16) / scoreWidth);
    const count = Math.max(1, Math.floor(Math.max(1, height - 46) / (rowHeight * scale)));
    return Array.from({length: Math.ceil(rows / count)}, (_, i) => ({
      phrase, start: i * count, end: Math.min(rows, (i + 1) * count),
    }));
  });
}

export class SheetMusic {
  constructor(container) {
    this.container = container;
    this.phrases = [];
    this.options = {tempo: 'auto', bpm: 120, meter: '4/4', flats: null};
    this.pending = new Set();
    this.timer = null;
    this.lastTick = null;
    this.pages = [];
    this.selection = null;
    this.onPage = () => {};
    this.onError = error => { throw error; };
    this.observer = new ResizeObserver(() => {
      if (!container.clientWidth) return;
      for (const phrase of this.phrases) this.schedule(phrase);
    });
    this.observer.observe(container);
  }

  async ready() {
    if (!window.VexFlow) throw new Error('The local sheet-music library is missing. Run piano-duet setup.');
    await document.fonts.ready;
    for (const family of ['Bravura', 'Academico']) {
      const faces = [...document.fonts].filter(font => font.family === family);
      if (!faces.length || faces.some(font => font.status !== 'loaded')) throw new Error(`Sheet music font ${family} could not load.`);
    }
  }

  heard(notes, key, {kind = 'you', label = null} = {}) {
    this.playback(null);
    this.replyPhrase = null;
    if (!notes.length) return;
    this.addPhrase(kind, notes, estimateTempo(notes), key, label);
  }

  reply(note, {kind = 'duet', label = null} = {}) {
    if (!this.replyPhrase) {
      const heard = this.phrases.at(-1);
      this.replyPhrase = this.addPhrase(kind, [], heard?.bpm || 120, heard?.key, label);
    }
    this.replyPhrase.notes.push({...note});
    this.schedule(this.replyPhrase);
  }

  addPhrase(kind, notes, bpm, key, labelText = null) {
    this.container.querySelector('.sheet-empty')?.remove();
    const article = document.createElement('article');
    article.className = `score-phrase ${kind}`;
    const heading = document.createElement('div');
    heading.className = 'score-heading';
    const name = document.createElement('h2');
    name.textContent = labelText || `${kind === 'you' ? 'You' : 'Duet'} · ${Math.floor(this.phrases.length / 2) + 1}`;
    const label = document.createElement('span');
    heading.append(name, label);
    const score = document.createElement('div');
    score.className = 'engraving';
    score.setAttribute('role', 'img');
    score.tabIndex = 0;
    article.append(heading, score);
    this.container.append(article);
    const phrase = {kind, title: name.textContent, notes: notes.map(note => ({...note})), bpm, key, article, label, score,
      marks: []};
    this.phrases.push(phrase);
    this.selection = {phrase, row: 0};
    this.schedule(phrase);
    return phrase;
  }

  schedule(phrase) {
    this.pending.add(phrase);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = [...this.pending];
      this.pending.clear();
      for (const current of pending) {
        if (!current.notes.length || !this.container.clientWidth) continue;
        current.article.hidden = false;
        try { this.render(current); } catch (error) { this.onError(error); }
      }
      this.pages = paginateSystems(this.phrases, this.container.clientWidth, this.container.clientHeight);
      const index = this.pages.findIndex(page => page.phrase === this.selection?.phrase
        && this.selection.row >= page.start && this.selection.row < page.end);
      this.showPage(Math.max(0, index));
      this.lastTick = null;
    }, 100);
  }

  configure(options) {
    this.options = {...this.options, ...options};
    for (const phrase of this.phrases) this.schedule(phrase);
  }

  showPage(index) {
    if (!this.pages.length) { this.onPage({index: 0, total: 0}); return; }
    index = Math.max(0, Math.min(this.pages.length - 1, index));
    const page = this.pages[index];
    this.selection = {phrase: page.phrase, row: page.start};
    for (const phrase of this.phrases) phrase.article.hidden = phrase !== page.phrase;
    const {rowHeight, scoreWidth, top} = page.phrase.layout;
    const y = page.start * rowHeight + (page.start === 0 ? top : 0);
    const height = (page.end - page.start) * rowHeight + 10 - (page.start === 0 ? top : 0);
    const svg = page.phrase.score.querySelector('svg');
    const scale = Math.min(page.phrase.score.clientWidth / scoreWidth, page.phrase.score.clientHeight / height);
    svg.setAttribute('viewBox', `0 ${y} ${scoreWidth} ${height}`);
    svg.style.width = `${scoreWidth * scale}px`;
    svg.style.height = `${height * scale}px`;
    this.pageIndex = index;
    this.onPage({index, total: this.pages.length});
  }

  turnPage(direction) { this.showPage((this.pageIndex || 0) + direction); }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.phrases = [];
    this.replyPhrase = null;
    this.pages = [];
    this.selection = null;
    this.lastTick = null;
    this.onPage({index: 0, total: 0});
    this.container.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'sheet-empty';
    empty.innerHTML = '<span aria-hidden="true">𝄞</span><p>Start with a few notes.</p><small>Your music will appear here.</small>';
    this.container.append(empty);
  }

  playback(seconds) {
    const phrase = this.replyPhrase;
    if (!phrase) return;
    const bpm = phrase.kind === 'target' || this.options.tempo === 'auto' ? phrase.bpm : this.options.bpm;
    const origin = phrase.notes.length ? Math.min(...phrase.notes.map(note => note.start)) : 0;
    const tick = seconds === null ? -1 : Math.floor((seconds - origin) * bpm / 60 * 4);
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    for (const mark of phrase.marks) {
      const active = tick >= mark.start && tick < mark.end;
      mark.element?.classList.toggle('score-sounding', active);
    }
    const active = phrase.marks.find(mark => tick >= mark.start && tick < mark.end);
    if (active) {
      const index = this.pages.findIndex(page => page.phrase === phrase && active.row >= page.start && active.row < page.end);
      if (index >= 0 && index !== this.pageIndex) this.showPage(index);
    }
  }

  render(phrase) {
    const {Renderer, Stave, StaveNote, Voice, Formatter, Beam, Fraction,
      Accidental, Dot, StaveConnector, StaveTie} = window.VexFlow;
    const bpm = phrase.kind === 'target' || this.options.tempo === 'auto' ? phrase.bpm : this.options.bpm;
    const model = createScore(phrase.notes, {bpm, meter: phrase.kind === 'target' ? '4/4' : this.options.meter});
    const signature = phrase.key?.signature || 'C';
    const flats = this.options.flats ?? Boolean(phrase.key?.scale_names.some(name => name.includes('b')));
    const signatureWidth = (phrase.key?.scale_names.filter(name => name.length > 1).length || 0) * 12;
    const [numBeats, beatValue] = model.meter.split('/').map(Number);
    const bars = model.bars.map(bar => {
      const parts = {};
      for (const clef of ['treble', 'bass']) {
        const notes = bar[clef].map(part => {
          const rest = part.notes.length === 0;
          const note = new StaveNote({clef, keys: rest ? [clef === 'bass' ? 'd/3' : 'b/4']
            : part.notes.map(item => spellPitch(item.pitch, flats, phrase.key).key),
          duration: part.value + (part.dotted ? 'd' : '') + (rest ? 'r' : ''), autoStem: true});
          if (part.dotted) Dot.buildAndAttach([note], {all: true});
          return {part, note};
        });
        const voice = new Voice({numBeats, beatValue}).addTickables(notes.map(item => item.note));
        Accidental.applyAccidentals([voice], signature);
        parts[clef] = {notes, voice};
      }
      const voices = [parts.treble.voice, parts.bass.voice];
      const formatter = new Formatter().joinVoices([voices[0]]).joinVoices([voices[1]]);
      const minimum = formatter.preCalculateMinTotalWidth(voices) + 45;
      return {parts, voices, minimum, formatter};
    });
    const viewport = Math.max(280, this.container.clientWidth - 16);
    const width = Math.max(viewport, ...bars.map(bar => bar.minimum + 125 + signatureWidth));
    const margin = 22;
    const usable = width - 2 * margin;
    const rows = [];
    let row = [], occupied = 0;
    for (const bar of bars) {
      const space = Math.max(250, bar.minimum + (row.length ? 0 : 85 + signatureWidth));
      if (row.length && (occupied + space > usable || row.length >= 2)) {
        rows.push(row);
        row = [];
        occupied = 0;
      }
      const required = Math.max(250, bar.minimum + (row.length ? 0 : 85 + signatureWidth));
      row.push({...bar, required});
      occupied += required;
    }
    if (row.length) rows.push(row);
    const trebleHigh = Math.max(81, ...phrase.notes.filter(n => n.pitch >= 60).map(n => n.pitch));
    const bassLow = Math.min(40, ...phrase.notes.filter(n => n.pitch < 60).map(n => n.pitch));
    const topExtra = Math.max(0, (trebleHigh - 81) * 3);
    const bottomExtra = Math.max(0, (40 - bassLow) * 3);
    const staffGap = 104;
    const rowHeight = 232 + topExtra + bottomExtra;
    phrase.score.replaceChildren();
    phrase.marks = [];
    const renderer = new Renderer(phrase.score, Renderer.Backends.SVG);
    renderer.resize(width, rows.length * rowHeight + 10);
    const ctx = renderer.getContext();
    ctx.setFillStyle('#25312d').setStrokeStyle('#25312d');
    const previous = new Map();
    const ties = [];
    let barNumber = 0;
    rows.forEach((barsInRow, rowIndex) => {
      const sum = barsInRow.reduce((total, bar) => total + bar.required, 0);
      const extra = (usable - sum) / barsInRow.length;
      let x = margin;
      barsInRow.forEach((bar, index) => {
        const barWidth = bar.required + extra;
        const y = rowIndex * rowHeight + topExtra + 8;
        const treble = new Stave(x, y, barWidth);
        const bass = new Stave(x, y + staffGap, barWidth);
        if (index === 0) {
          treble.addClef('treble').addKeySignature(signature);
          bass.addClef('bass').addKeySignature(signature);
        }
        if (barNumber === 0) { treble.addTimeSignature(model.meter); bass.addTimeSignature(model.meter); }
        const startX = Math.max(treble.getNoteStartX(), bass.getNoteStartX());
        treble.setNoteStartX(startX); bass.setNoteStartX(startX);
        treble.setContext(ctx).draw(); bass.setContext(ctx).draw();
        if (index === 0) new StaveConnector(treble, bass).setType('brace').setContext(ctx).draw();
        new StaveConnector(treble, bass).setType('singleLeft').setContext(ctx).draw();
        if (index === barsInRow.length - 1) new StaveConnector(treble, bass).setType('singleRight').setContext(ctx).draw();
        ctx.save(); ctx.setFont('sans-serif', 9); ctx.setFillStyle('#87918a');
        ctx.fillText(String(barNumber + 1), x + 5, y + 15); ctx.restore();
        const beams = [];
        for (const clef of ['treble', 'bass']) {
          const stave = clef === 'treble' ? treble : bass;
          bar.parts[clef].voice.setStave(stave);
          for (const item of bar.parts[clef].notes) item.note.setStave(stave);
          beams.push(...Beam.generateBeams(bar.parts[clef].notes.map(item => item.note), {
            groups: [model.meter === '6/8' ? new Fraction(3, 8) : new Fraction(1, 4)],
          }));
        }
        bar.formatter.format(bar.voices, x + barWidth - startX - 24);
        bar.parts.treble.voice.draw(ctx, treble);
        bar.parts.bass.voice.draw(ctx, bass);
        for (const beam of beams) beam.setContext(ctx).draw();
        for (const clef of ['treble', 'bass']) {
          for (const item of bar.parts[clef].notes) {
            const element = item.note.getSVGElement();
            phrase.marks.push({element, start: item.part.start, end: item.part.end, row: rowIndex});
            item.part.notes.forEach((note, noteIndex) => {
              const prev = previous.get(note.id);
              if (note.tied && prev) {
                if (prev.rowIndex === rowIndex) ties.push({firstNote: prev.note, lastNote: item.note,
                  firstIndexes: [prev.index], lastIndexes: [noteIndex]});
                else {
                  ties.push({firstNote: prev.note, firstIndexes: [prev.index]});
                  ties.push({lastNote: item.note, lastIndexes: [noteIndex]});
                }
              }
              previous.set(note.id, {note: item.note, index: noteIndex, rowIndex});
            });
          }
        }
        x += barWidth;
        barNumber++;
      });
    });
    for (const tie of ties) new StaveTie(tie).setContext(ctx).draw();
    const svg = phrase.score.querySelector('svg');
    svg.setAttribute('aria-hidden', 'true');
    const bounds = svg.getBBox();
    const top = Math.min(0, bounds.y - 8);
    const height = Math.max(rows.length * rowHeight + 10, bounds.y + bounds.height + 8) - top;
    renderer.resize(width, height);
    svg.setAttribute('viewBox', `0 ${top} ${width} ${height}`);
    svg.style.width = '100%';
    svg.style.height = '100%';
    phrase.layout = {rows: rows.length, rowHeight, scoreWidth: width, top};
    const keyLabel = phrase.key ? `${phrase.key.name} · ` : '';
    phrase.label.textContent = `${keyLabel}♩ = ${bpm}${this.options.tempo === 'auto' && phrase.kind !== 'target' ? ' estimated' : ''} · ${model.meter} · ${phrase.notes.length} notes`;
    phrase.score.setAttribute('aria-label', `${phrase.title}: ${keyLabel}${phrase.notes.length} notes on treble and bass staves, ${model.meter}, quarter note equals ${bpm} BPM.`);
  }
}
