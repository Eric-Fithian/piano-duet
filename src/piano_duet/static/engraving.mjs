// Engraves one score as separate systems, each its own SVG sized to what it actually draws. Systems never share
// a canvas, so a low beam or a ledger-line note can never bleed into the neighbouring line.
import {createScore, spellPitch} from './notation.mjs';

const MARGIN = 14;
const OPENING = 50;
const TIME_SIGNATURE = 22;
const STAFF_TOP = 60;
const GRAND_GAP = 104;
// Room above and below the staves that every system keeps, so lines of plain notes line up evenly.
const CLEARANCE = 22;
export const MIN_NOTE_GAP = 5;

// Bars of each system, as [start, end) ranges: the fewest lines the width allows, with the bars shared out so the
// lines are as evenly full as possible (no stub of a last line). A bar too wide for any line gets a line of its own.
export function planSystems(widths, available, {first = 0, rest = 0, maxBars = null} = {}) {
  const count = widths.length;
  if (!count) return [];
  const prefix = [0];
  for (const width of widths) prefix.push(prefix.at(-1) + width);
  const span = (start, end) => (start === 0 ? first : rest) + prefix[end] - prefix[start];
  const fits = (start, end) => (end - start === 1 || span(start, end) <= available) && (!maxBars || end - start <= maxBars);
  let lines = 0;
  for (let start = 0; start < count; lines++) {
    let end = start + 1;
    while (end < count && fits(start, end + 1)) end++;
    start = end;
  }
  // cost[k][end]: the least squared slack of setting bars [0, end) on k lines.
  const cost = Array.from({length: lines + 1}, () => Array(count + 1).fill(Infinity));
  const from = Array.from({length: lines + 1}, () => Array(count + 1).fill(-1));
  cost[0][0] = 0;
  for (let k = 1; k <= lines; k++) {
    for (let end = 1; end <= count; end++) {
      for (let start = end - 1; start >= 0 && fits(start, end); start--) {
        if (cost[k - 1][start] === Infinity) continue;
        const slack = Math.max(0, available - span(start, end));
        const total = cost[k - 1][start] + slack * slack;
        if (total < cost[k][end]) { cost[k][end] = total; from[k][end] = start; }
      }
    }
  }
  const ranges = [];
  for (let k = lines, end = count; k > 0; k--) {
    const start = from[k][end];
    ranges.unshift([start, end]);
    end = start;
  }
  return ranges;
}

// A bar's comfortable width when it is not stretched to fill a line.
export function naturalWidth(minimum) {
  return Math.max(150, minimum * 1.3);
}

function clefsOf(doc) {
  return doc.clef && doc.clef !== 'grand' ? [doc.clef] : ['treble', 'bass'];
}

function buildBars(model, doc, clefs, flats) {
  const {StaveNote, GhostNote, GraceNote, GraceNoteGroup, Voice, Formatter, Accidental, Dot, Tuplet} = window.VexFlow;
  const [numBeats, beatValue] = model.meter.split('/').map(Number);
  const signature = doc.key?.signature || 'C';
  const build = (clef, written, stemDirection, hidden) => {
    const notes = written.map(part => {
      const rest = part.notes.length === 0;
      const duration = part.value + (part.dotted ? 'd' : '');
      // The second voice's gaps stay invisible so only the main voice shows rests.
      const note = rest && hidden ? new GhostNote({duration})
        : new StaveNote({clef, keys: rest ? [clef === 'bass' ? 'd/3' : 'b/4']
          : part.notes.map(item => spellPitch(item.pitch, flats, doc.key).key),
        duration: duration + (rest ? 'r' : ''), ...(stemDirection ? {stemDirection} : {autoStem: true})});
      if (part.dotted && !(rest && hidden)) Dot.buildAndAttach([note], {all: true});
      if (part.graces && !rest) {
        // Slashed eighths, each with the accidental the key signature does not already give it.
        const graces = part.graces.map(grace => {
          const spelled = spellPitch(grace.pitch, flats, doc.key);
          const inKey = doc.key ? doc.key.pitch_classes.includes(grace.pitch % 12) : spelled.accidental === 'n';
          const graceNote = new GraceNote({keys: [spelled.key], duration: '8', slash: true, clef});
          if (!inKey) graceNote.addModifier(new Accidental(spelled.accidental), 0);
          return graceNote;
        });
        note.addModifier(new GraceNoteGroup(graces, true).beamNotes(), 0);
      }
      return {part, note};
    });
    const tuplets = [];
    for (let i = 0; i < notes.length; i++) {
      if (!notes[i].part.tuplet) continue;
      const group = notes.slice(i, i + 3);
      if (group.length !== 3 || group.some(item => item.part.tuplet !== 3)) throw new Error('A triplet must contain three written notes or rests.');
      const tuplet = new Tuplet(group.map(item => item.note));
      if (group.some(item => !(item.note instanceof GhostNote))) tuplets.push(tuplet);
      i += 2;
    }
    return {notes, voice: new Voice({numBeats, beatValue}).addTickables(notes.map(item => item.note)), tuplets, stemDirection};
  };
  return model.bars.map(bar => {
    const parts = {};
    for (const clef of clefs) {
      const second = bar.second[clef];
      parts[clef] = [build(clef, bar[clef], second ? 1 : null, false), ...(second ? [build(clef, second, -1, true)] : [])];
      Accidental.applyAccidentals(parts[clef].map(layer => layer.voice), signature);
    }
    const voices = clefs.flatMap(clef => parts[clef].map(layer => layer.voice));
    const formatter = new Formatter();
    for (const clef of clefs) formatter.joinVoices(parts[clef].map(layer => layer.voice));
    return {source: bar, parts, voices, formatter, minimum: formatter.preCalculateMinTotalWidth(voices) + 10};
  });
}

// Treble notes below middle C and bass notes above it need room between the staves of a grand staff.
function staffGap(model, range) {
  const notes = model.quantized.filter(note => note.start < model.bars[range[1] - 1].end && note.end > model.bars[range[0]].start);
  const trebleLow = Math.min(60, ...notes.filter(note => note.staff === 'treble').map(note => note.pitch));
  const bassHigh = Math.max(57, ...notes.filter(note => note.staff === 'bass').map(note => note.pitch));
  return GRAND_GAP + (60 - trebleLow) * 2.5 + (bassHigh - 57) * 2.5;
}

/**
 * Engraves `doc` into `host`, one `.score-system` per line, and returns the systems and the marks of every written
 * note. `width` is the line width in staff units; null lays every bar out on a single line at its natural width.
 */
export function engrave(doc, host, {width = null, maxBars = null, barNumbers = 'systems'} = {}) {
  return engraveSpaced(doc, host, {width, maxBars, barNumbers}, new Map(), 0);
}

function engraveSpaced(doc, host, options, extraSpace, attempt) {
  const {width, maxBars, barNumbers} = options;
  const {Renderer, Stave, GhostNote, Beam, Fraction, StaveConnector, StaveTie} = window.VexFlow;
  const model = createScore(doc.notes, {bpm: doc.bpm, meter: doc.meter, exact: Boolean(doc.exact), bars: doc.bars || 0});
  const clefs = clefsOf(doc);
  const flats = doc.flats ?? Boolean(doc.key?.scale_names.some(name => name.includes('b')));
  const signature = doc.key?.signature || 'C';
  const signatureWidth = (doc.key?.scale_names.filter(name => name.length > 1).length || 0) * 12;
  const bars = buildBars(model, doc, clefs, flats);
  bars.forEach((bar, index) => { bar.minimum += extraSpace.get(index) || 0; });
  const opening = OPENING + signatureWidth;
  const ranges = width === null ? [[0, bars.length]]
    : planSystems(bars.map(bar => bar.minimum), width - 2 * MARGIN, {first: opening + TIME_SIGNATURE, rest: opening, maxBars});
  const beamGroups = model.meter === '7/8' ? [new Fraction(2, 8), new Fraction(2, 8), new Fraction(3, 8)]
    : [['6/8', '9/8', '12/8'].includes(model.meter) ? new Fraction(3, 8) : new Fraction(1, 4)];
  host.replaceChildren();
  const marks = [];
  const previous = new Map();
  const systems = ranges.map((range, systemIndex) => {
    const element = document.createElement('div');
    element.className = 'score-system';
    host.append(element);
    const inLine = bars.slice(...range);
    const extra = opening + (systemIndex === 0 ? TIME_SIGNATURE : 0);
    const widths = inLine.map(bar => bar.minimum);
    const minimumLineWidth = 2 * MARGIN + extra + widths.reduce((sum, value) => sum + value, 0);
    const lineWidth = width === null
      ? 2 * MARGIN + extra + widths.reduce((sum, minimum) => sum + naturalWidth(minimum), 0)
      : Math.max(width, minimumLineWidth);
    const natural = width === null;
    const stretch = natural ? 0 : (lineWidth - 2 * MARGIN - extra - widths.reduce((sum, value) => sum + value, 0)) / inLine.length;
    const renderer = new Renderer(element, Renderer.Backends.SVG);
    renderer.resize(lineWidth, 400);
    const ctx = renderer.getContext();
    ctx.setFillStyle('#25312d').setStrokeStyle('#25312d');
    const gap = clefs.length === 2 ? staffGap(model, range) : 0;
    const ties = [];
    const systemMarks = [];
    let first = null;
    let x = MARGIN;
    inLine.forEach((bar, index) => {
      const barNumber = range[0] + index;
      const barWidth = (natural ? naturalWidth(bar.minimum) : bar.minimum + stretch) + (index === 0 ? extra : 0);
      const treble = new Stave(x, STAFF_TOP, barWidth);
      const bass = new Stave(x, STAFF_TOP + gap, barWidth);
      if (index === 0) {
        treble.addClef('treble').addKeySignature(signature);
        bass.addClef('bass').addKeySignature(signature);
      }
      if (barNumber === 0) { treble.addTimeSignature(model.meter); bass.addTimeSignature(model.meter); }
      const startX = Math.max(treble.getNoteStartX(), bass.getNoteStartX());
      treble.setNoteStartX(startX); bass.setNoteStartX(startX);
      const staves = {treble, bass};
      first = first || staves;
      for (const clef of clefs) staves[clef].setContext(ctx).draw();
      if (clefs.length === 2) {
        if (index === 0) new StaveConnector(treble, bass).setType('brace').setContext(ctx).draw();
        new StaveConnector(treble, bass).setType('singleLeft').setContext(ctx).draw();
        if (index === inLine.length - 1) new StaveConnector(treble, bass).setType('singleRight').setContext(ctx).draw();
      }
      if (barNumbers === 'all' || (barNumbers === 'systems' && index === 0 && barNumber > 0)) {
        ctx.save(); ctx.setFont('sans-serif', 9); ctx.setFillStyle('#87918a');
        ctx.fillText(String(barNumber + 1), x + (index === 0 ? 2 : 5), staves[clefs[0]].getYForLine(0) - 8); ctx.restore();
      }
      const beams = [];
      const layers = clefs.flatMap(clef => bar.parts[clef].map(layer => ({clef, layer})));
      for (const {clef, layer} of layers) {
        layer.voice.setStave(staves[clef]);
        for (const item of layer.notes) item.note.setStave(staves[clef]);
        beams.push(...Beam.generateBeams(layer.notes.map(item => item.note), {
          groups: beamGroups, ...(layer.stemDirection ? {stemDirection: layer.stemDirection} : {}),
        }));
      }
      bar.formatter.format(bar.voices, x + barWidth - startX - 24);
      for (const {clef, layer} of layers) layer.voice.draw(ctx, staves[clef]);
      for (const beam of beams) beam.setContext(ctx).draw();
      for (const {layer} of layers) for (const tuplet of layer.tuplets) tuplet.setContext(ctx).draw();
      for (const {clef, layer} of layers) {
        for (const item of layer.notes) {
          if (item.note instanceof GhostNote) continue;
          const noteElement = item.note.getSVGElement();
          for (const [noteIndex, source] of item.part.notes.entries()) {
            const finger = doc.notes[source.id].finger;
            if (!finger || source.tied) continue;
            const head = item.note.noteHeads[noteIndex];
            const noteY = item.note.getYs()[noteIndex];
            const stemUp = item.note.getStemDirection() === 1;
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', head.getAbsoluteX() + head.getWidth() / 2 + (noteIndex - (item.part.notes.length - 1) / 2) * 14);
            label.setAttribute('y', stemUp ? Math.max(noteY + 19, staves[clef].getYForLine(4) + 17)
              : Math.min(noteY - 12, staves[clef].getYForLine(0) - 10));
            label.setAttribute('class', 'score-finger');
            label.setAttribute('data-finger', finger);
            label.textContent = String(finger);
            noteElement.append(label);
          }
          const mark = {element: noteElement, start: item.part.start, end: item.part.end, system: systemIndex, bar: barNumber,
            ids: item.part.notes.map(note => note.id), tiedIds: item.part.notes.filter(note => note.tied).map(note => note.id),
            note: item.note, staves, clef};
          systemMarks.push(mark);
          item.part.notes.forEach((note, position) => {
            const prior = previous.get(note.id);
            if (note.tied && prior) {
              if (prior.system === systemIndex) {
                ties.push({firstNote: prior.note, lastNote: item.note, firstIndexes: [prior.index], lastIndexes: [position]});
              } else {
                prior.ties.push({firstNote: prior.note, firstIndexes: [prior.index]});
                ties.push({lastNote: item.note, lastIndexes: [position]});
              }
            }
            previous.set(note.id, {note: item.note, index: position, system: systemIndex, ties});
          });
        }
      }
      x += barWidth;
    });
    marks.push(...systemMarks);
    return {element, ctx, ties, marks: systemMarks, bars: range, width: lineWidth, renderer, clefs, staves: first};
  });
  for (const system of systems) {
    for (const tie of system.ties) new StaveTie(tie).setContext(system.ctx).draw();
    const svg = system.element.querySelector('svg');
    svg.setAttribute('aria-hidden', 'true');
    const staffTop = Math.min(...system.clefs.map(clef => system.staves[clef].getYForLine(0)));
    const staffBottom = Math.max(...system.clefs.map(clef => system.staves[clef].getYForLine(4)));
    // Font glyphs report their whole line height, so the frame comes from the notes' own geometry instead.
    const boxes = system.marks.map(mark => mark.note.getBoundingBox()).filter(Boolean);
    const tuplets = system.marks.some(mark => mark.note.getTuplet?.()) ? 16 : 0;
    const top = Math.min(staffTop - CLEARANCE, ...boxes.map(box => box.getY() - tuplets)) - 6;
    const bottom = Math.max(staffBottom + CLEARANCE, ...boxes.map(box => box.getY() + box.getH())) + 6;
    system.frame = {top, height: bottom - top, width: system.width};
    system.svg = svg;
    svg.setAttribute('viewBox', `0 ${top} ${system.width} ${bottom - top}`);
    delete system.ctx;
    delete system.ties;
    delete system.renderer;
    delete system.staves;
  }
  // VexFlow's minimum can let dense noteheads touch, so feed measured deficits back into the system plan.
  const deficits = new Map();
  for (const system of systems) for (const clef of clefs) {
    const columns = new Map();
    for (const mark of system.marks.filter(item => item.clef === clef && item.ids.length)) {
      const left = Math.min(...mark.note.noteHeads.map(head => head.getAbsoluteX()));
      const right = Math.max(...mark.note.noteHeads.map(head => head.getAbsoluteX() + head.getWidth()));
      const column = columns.get(mark.start);
      columns.set(mark.start, {bar: mark.bar, left: Math.min(left, column?.left ?? Infinity), right: Math.max(right, column?.right ?? -Infinity)});
    }
    const ordered = [...columns.entries()].sort(([a], [b]) => a - b).map(([, column]) => column);
    const counts = new Map();
    for (const column of ordered) counts.set(column.bar, (counts.get(column.bar) || 0) + 1);
    for (let index = 1; index < ordered.length; index++) {
      const before = ordered[index - 1];
      const deficit = MIN_NOTE_GAP - (ordered[index].left - before.right);
      if (deficit > 0.01) deficits.set(before.bar, Math.max(deficits.get(before.bar) || 0, Math.max(20, Math.ceil(deficit * counts.get(before.bar) * 2))));
    }
  }
  if (deficits.size) {
    if (attempt >= 64) throw new Error('The score could not be spaced without overlapping noteheads.');
    for (const [bar, extra] of deficits) extraSpace.set(bar, (extraSpace.get(bar) || 0) + extra);
    return engraveSpaced(doc, host, options, extraSpace, attempt + 1);
  }
  const header = width === null && systems.length ? engraveHeader(host, systems[0], clefs, signature, opening, staffGap(model, ranges[0])) : null;
  return {systems, header, marks, model, ticksPerBeat: model.ticksPerBeat, endTick: Math.max(0, ...marks.map(mark => mark.end))};
}

// The clef and key signature of a single long line, pinned at the left edge while the line scrolls past.
function engraveHeader(host, first, clefs, signature, opening, gap) {
  const {Renderer, Stave, StaveConnector} = window.VexFlow;
  const element = document.createElement('div');
  element.className = 'score-header';
  host.prepend(element);
  const width = MARGIN + opening - 4;
  const renderer = new Renderer(element, Renderer.Backends.SVG);
  renderer.resize(width, 400);
  const ctx = renderer.getContext();
  ctx.setFillStyle('#25312d').setStrokeStyle('#25312d');
  const staves = {treble: new Stave(MARGIN, STAFF_TOP, width - MARGIN), bass: new Stave(MARGIN, STAFF_TOP + gap, width - MARGIN)};
  for (const clef of clefs) staves[clef].addClef(clef).addKeySignature(signature).setContext(ctx).draw();
  if (clefs.length === 2) {
    new StaveConnector(staves.treble, staves.bass).setType('brace').setContext(ctx).draw();
    new StaveConnector(staves.treble, staves.bass).setType('singleLeft').setContext(ctx).draw();
  }
  const svg = element.querySelector('svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', `0 ${first.frame.top} ${width} ${first.frame.height}`);
  return {element, svg, frame: {top: first.frame.top, height: first.frame.height, width}};
}
