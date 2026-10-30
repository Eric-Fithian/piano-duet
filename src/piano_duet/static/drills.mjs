import {localRequest} from './practice.mjs';
import {pitchName} from './learning.mjs';

const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const STORAGE = 'piano-duet.drill';
const FIELDS = ['drill', 'variant', 'tonic', 'hands', 'octaves', 'inversion', 'practice'];
const NUMERIC = ['tonic', 'octaves', 'inversion'];
const SELECTS = {drill: 'drillKind', variant: 'drillVariant', tonic: 'drillKey', hands: 'drillHands', octaves: 'drillOctaves', inversion: 'drillInversion', practice: 'drillPractice'};
const RANDOM = 'random';
const SUBDIVISION = {1: 'quarters', 2: 'eighths', 3: 'triplets', 4: 'sixteenths'};
const FIELD_NAMES = {drill: 'drill', variant: 'type', tonic: 'key', hands: 'hands', octaves: 'range', inversion: 'start', practice: 'practice'};
// Validated (dataviz validator, dark surface #141a22): late and early read as opposite poles.

const accidentals = name => name.replace('b', '♭').replace('#', '♯');
const capitalized = text => text[0].toUpperCase() + text.slice(1);
const range = count => Array.from({length: count}, (_, index) => index);

function fill(select, options, value) {
  const field = Object.keys(SELECTS).find(name => SELECTS[name] === select.id);
  select.replaceChildren(new Option(`Random ${FIELD_NAMES[field]}`, RANDOM), ...options.map(([key, label]) => new Option(label, key)));
  const keys = options.map(([key]) => String(key));
  select.value = value === RANDOM || keys.includes(String(value)) ? String(value) : keys[0];
  select.closest('label').hidden = options.length < 2;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function allowedHands(spec, variant) {
  return spec.hands.filter(hand => !(hand === 'contrary' && variant === 'melodic minor'));
}

export function allowedOctaves(spec, hands) {
  return spec.octaves.filter(octaves => hands !== 'contrary' || octaves <= 2);
}

export function tempoLabel(perBeat, bpm) {
  return `♩ = ${bpm} in ${SUBDIVISION[perBeat]}`;
}

// Random choices are re-rolled for every rep; a fixed choice the drill cannot take is rolled too.
export function resolveChoices(catalog, choices, random = Math.random) {
  const pick = list => list[Math.floor(random() * list.length)];
  const choose = (value, allowed) => (value !== RANDOM && allowed.map(String).includes(String(value)) ? value : pick(allowed));
  const drill = choose(choices.drill, Object.keys(catalog.drills));
  const spec = catalog.drills[drill];
  const variant = choose(choices.variant, spec.variants);
  const hands = choose(choices.hands, allowedHands(spec, variant));
  return {
    drill,
    variant,
    tonic: Number(choose(choices.tonic, range(12))),
    hands,
    octaves: Number(choose(choices.octaves, allowedOctaves(spec, hands))),
    inversion: Number(choose(choices.inversion, range(Math.max(1, spec.inversions)))),
    practice: choose(choices.practice, spec.practices),
  };
}

// Sessions spend at least five minutes (or five takes) on a drill, in at most three blocks.
export function planSession(kind, amount) {
  const blocks = Math.max(1, Math.min(3, Math.floor(amount / 5)));
  return {kind, amount, blocks, per: amount / blocks};
}

export function streakText(entry, needed) {
  const count = entry ? entry.streak : 0;
  return `${count} of ${needed} clean in a row`;
}

// Where each attack of a drill sits on the page, so the score can follow the attacks heard.
export function attackPlan(task) {
  const starts = [...new Set(task.target.map(note => note.start))].sort((a, b) => a - b);
  const gaps = starts.slice(1).map((start, i) => start - starts[i]).sort((a, b) => a - b);
  return {gap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 60 / task.bpm, attacks: starts};
}

// Attacks with a real fraction of the take's played loudness; a counted "attack" far quieter than the notes
// around it is room sound or a ringing string, and must not keep a finished take open.
export function heardAttacks(times, strengths) {
  if (!times.length) return [];
  const sorted = [...strengths].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.75)];
  return times.filter((_, index) => strengths[index] >= typical * STRONG);
}
const STRONG = 0.2;

// The player's own spacing between attacks: the median of their last few, or the written spacing to begin with.
export function playedGap(plan, times) {
  const recent = times.slice(-5);
  const gaps = recent.slice(1).map((time, i) => time - recent[i]).sort((a, b) => a - b);
  return gaps.length >= 2 ? gaps[Math.floor(gaps.length / 2)] : plan.gap;
}

// A take ends soon after its attacks stop, not when the room falls quiet: a final note ringing to the end of its
// bar, or steady room noise, cannot hold it open. With every written attack heard it ends once a little more than
// the player's own spacing has passed; with most of them, after twice that, so a missed detection or a hesitation
// near the end does not cut the take off.
export function takeEnded(plan, count, sinceLast, gap) {
  const expected = plan.attacks.length;
  if (count >= expected) return sinceLast >= Math.max(0.4, 1.25 * gap);
  return count >= 0.8 * expected && sinceLast >= Math.max(0.8, 2 * gap);
}

// Where the player is, from attacks heard so far: glide toward the next written attack at their own pace.
export function followPosition(plan, count, sinceLast, gap) {
  if (!count) return 0;
  const index = Math.min(count, plan.attacks.length) - 1;
  const current = plan.attacks[index];
  const next = plan.attacks[index + 1];
  return next === undefined ? current : current + Math.min(1, sinceLast / gap) * (next - current);
}

// Guides for measures that do not decide a clean take.
const LOUDNESS_GUIDE = 80;
const ACCENT_GUIDE = 70;
const SYNC_GUIDE = 40;

export function meterState(value, target) {
  return value >= target ? 'good' : 'short';
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// The tempo the take opened with and the band it may drift within, plus where it closed, for the tempo lane.
export function tempoBand(rows, tolerance) {
  const tempos = rows.map(row => row.tempo).filter(tempo => tempo != null);
  if (tempos.length < 3) return null;
  const third = Math.max(1, Math.round(tempos.length / 3));
  const opening = medianOf(tempos.slice(0, third));
  const low = opening * (1 - tolerance / 100), high = opening * (1 + tolerance / 100);
  const min = Math.min(low, ...tempos), max = Math.max(high, ...tempos);
  return {opening, closing: medianOf(tempos.slice(-third)), low, high, min: min - (max - min) * 0.08, max: max + (max - min) * 0.08};
}

// Notes much louder or softer than the take's typical note. Accent practice is meant to be uneven, so it has none.
export function loudnessOutliers(rows, accents = false) {
  const velocities = rows.map(row => row.velocity).filter(value => value != null);
  if (accents || velocities.length < 3) return new Set();
  const typical = medianOf(velocities);
  return new Set(rows.flatMap((row, index) => (row.velocity != null && Math.abs(row.velocity - typical) / typical > 0.25 ? [index] : [])));
}

// A centred bar for a signed measure: the shaded band is what a clean take allows, the marker is the take.
function driftTrack(value, tolerance) {
  const range = Math.max(25, tolerance * 3, Math.abs(value) * 1.15);
  const track = element('span', undefined, 'drill-meter-track drill-meter-signed');
  const zone = element('s');
  zone.style.left = `${50 - 50 * tolerance / range}%`;
  zone.style.width = `${100 * tolerance / range}%`;
  const marker = element('i');
  const at = 50 + 50 * value / range;
  marker.style.left = `${Math.min(at, 50)}%`;
  marker.style.width = `${Math.abs(at - 50)}%`;
  track.append(zone, marker);
  return track;
}

export function issueSummary(result) {
  return result.issues.length ? result.issues : ['No pauses, rushes or missed notes stood out.'];
}

function union(catalog, field) {
  return [...new Set(Object.values(catalog.drills).flatMap(spec => spec[field]))];
}

export class DrillPicker {
  constructor() {
    this.catalog = null;
    this.progress = {};
    this.levels = {};
    this.streak = 0;
  }

  async refresh() {
    const data = await localRequest('/api/drills');
    if (!this.catalog) {
      this.catalog = data.catalog;
      const kind = $('drillKind');
      kind.replaceChildren(new Option('Random drill', RANDOM));
      for (const group of this.catalog.groups) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group;
        for (const [id, spec] of Object.entries(this.catalog.drills)) {
          if (spec.group === group) optgroup.append(new Option(spec.name, id));
        }
        kind.append(optgroup);
      }
    }
    this.progress = data.progress;
    this.levels = data.levels;
    this.streak = data.streak_days;
  }

  saved() {
    const stored = localStorage.getItem(STORAGE);
    if (stored === null) return null;
    const choices = JSON.parse(stored);
    if (!FIELDS.every(field => field in choices)) throw new Error('The saved drill is incomplete.');
    return choices;
  }

  save() {
    localStorage.setItem(STORAGE, JSON.stringify(this.read()));
  }

  // Show the choices, keeping each where the selected drill allows it; Random offers every drill's options.
  sync(choices) {
    const random = choices.drill === RANDOM;
    const spec = random ? null : this.catalog.drills[choices.drill];
    if (!random && !spec) throw new Error(`Unknown drill ${choices.drill}.`);
    $('drillKind').value = choices.drill;
    const variants = random ? union(this.catalog, 'variants') : spec.variants;
    fill($('drillVariant'), variants.map(variant => [variant, capitalized(variant)]), choices.variant);
    const variant = $('drillVariant').value;
    const minor = variant.includes('minor') || variant === 'diminished 7th';
    fill($('drillKey'), this.catalog.tonics[minor ? 'minor' : 'major'].map((name, tonic) => [tonic, accidentals(name)]), choices.tonic);
    const hands = random ? Object.keys(this.catalog.hands) : allowedHands(spec, variant);
    fill($('drillHands'), hands.map(hand => [hand, this.catalog.hands[hand]]), choices.hands);
    const octaves = random ? [1, 2, 3, 4] : allowedOctaves(spec, $('drillHands').value);
    fill($('drillOctaves'), octaves.map(count => [count, `${count} octave${count > 1 ? 's' : ''}`]), choices.octaves);
    fill($('drillInversion'), this.catalog.inversions.slice(0, random ? 3 : Math.max(1, spec.inversions)).map((name, index) => [index, name]), choices.inversion);
    const practices = random ? union(this.catalog, 'practices') : spec.practices;
    fill($('drillPractice'), practices.map(practice => [practice, this.catalog.practices[practice]]), choices.practice);
    $('drillSummary').textContent = random ? 'A different drill every rep.' : spec.summary;
  }

  read() {
    const choices = Object.fromEntries(FIELDS.map(field => {
      const value = $(SELECTS[field]).value;
      return [field, value === RANDOM || !NUMERIC.includes(field) ? value : Number(value)];
    }));
    return choices;
  }

  next() {
    return resolveChoices(this.catalog, this.read());
  }

  renderSummary(title, lines, onAgain) {
    const panel = $('drillResults');
    panel.replaceChildren();
    const head = element('div', undefined, 'drill-results-head');
    const again = element('button', 'Another session', 'quiet-button');
    again.addEventListener('click', onAgain);
    const close = element('button', '✕', 'icon-button');
    close.setAttribute('aria-label', 'Hide summary');
    close.addEventListener('click', () => { panel.hidden = true; });
    head.append(element('strong', title, 'clean'), element('span'), again, close);
    const list = element('ul', undefined, 'drill-issues');
    for (const line of lines.length ? lines : ['No tempo or level changes this time. Consistency builds before speed does.']) list.append(element('li', line));
    panel.append(head, list);
    panel.hidden = false;
  }

  adopt(config) {
    this.sync(config);
    this.save();
  }

  show(task) {
    const drill = task.drill;
    $('drillTempo').textContent = drill.bpm;
    $('drillSubdivision').textContent = SUBDIVISION[drill.per_beat];
    const level = this.levels[drill.drill];
    $('drillLevelNumber').textContent = level.level;
    $('drillLevelFill').style.width = `${level.next ? 100 * level.next.done / level.next.keys : 100}%`;
    $('drillLevel').title = `${level.name}: level ${level.level}${level.next ? ` · next: ${level.next.done} of ${level.next.keys} keys at ${tempoLabel(level.next.tempo.per_beat, level.next.tempo.bpm)}` : ' · top level'}`;
    $('drillLevel').setAttribute('aria-label', $('drillLevel').title);
    $('drillSlower').disabled = drill.rung === 0;
    $('drillFaster').disabled = drill.rung === drill.rungs - 1;
    $('drillLadderFill').style.width = `${100 * drill.rung / Math.max(1, drill.rungs - 1)}%`;
    const {reached, next} = drill.milestone;
    const ladder = this.catalog.drills[drill.drill].ladder;
    const working = ladder[drill.working];
    const best = drill.best === null ? null : ladder[drill.best];
    const notes = [best ? `Your steady tempo ♩ ${best.bpm} in ${SUBDIVISION[best.per_beat]}` : 'Play at any tempo you can hold steadily',
      drill.rung === drill.working ? 'this is the suggestion' : `suggested ${tempoLabel(working.per_beat, working.bpm)}`];
    if (reached) notes.push(`meets ${reached}`);
    if (next) notes.push(`next: ${next.label} at ${tempoLabel(next.per_beat, next.bpm)}`);
    $('drillMilestone').textContent = notes.join(' · ');
    $('drillTempoControl').title = notes.join(' · ');
    $('drillTitle').textContent = task.title;
    const choices = this.read();
    const shuffled = FIELDS.filter(field => choices[field] === RANDOM
      && !$(SELECTS[field]).closest('label').hidden);
    $('drillCue').textContent = [task.cue, shuffled.length && `random ${shuffled.map(field => FIELD_NAMES[field]).join(', ')}`].filter(Boolean).join(' · ');
  }

  entry(task) {
    return this.progress[task.drill.config_key] || null;
  }

  // One header line, a meter for each measure against its clean target, and a note-by-note timeline of the take:
  // tempo, timing and loudness, so where a take went wrong is visible at a glance.
  renderResults(task, assessment, onReview, progress = null) {
    const result = assessment.drill;
    const panel = $('drillResults');
    panel.replaceChildren();
    const head = element('div', undefined, 'drill-results-head');
    const verdict = element('strong', result.clean ? '✓ Clean' : result.usable ? 'Not clean yet' : 'Uncertain recognition', result.clean ? 'clean' : '');
    verdict.title = issueSummary(result).join('\n');
    const review = element('button', 'Review notes', 'quiet-button');
    review.addEventListener('click', onReview);
    const close = element('button', '✕', 'icon-button');
    close.setAttribute('aria-label', 'Hide results');
    close.addEventListener('click', () => { panel.hidden = true; });
    head.append(verdict, element('span', assessment.feedback), ...(progress ? [element('em', progress, 'drill-progress-line')] : []), review, close);
    const body = element('div', undefined, 'drill-results-body');
    body.append(this.meters(task, assessment), this.timeline(task, result));
    panel.append(head, body);
    panel.hidden = false;
  }

  meters(task, assessment) {
    const result = assessment.drill;
    const targets = result.targets;
    const list = element('div', undefined, 'drill-meters');
    const row = (label, state, track, value, detail) => {
      const item = element('div', undefined, `drill-meter ${state}`);
      item.title = detail;
      item.append(element('span', label, 'drill-meter-label'), track, element('b', value, 'drill-meter-value'));
      list.append(item);
    };
    const bar = (value, target) => {
      const track = element('span', undefined, 'drill-meter-track');
      const fill = element('i');
      fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
      track.append(fill);
      if (target !== null) {
        const tick = element('u');
        tick.style.left = `${target}%`;
        track.append(tick);
      }
      return track;
    };
    const score = assessment.score;
    row('Notes', meterState(result.pitch, targets.pitch), bar(result.pitch, targets.pitch), `${result.pitch}%`,
      `${score.missing} missed · ${score.extra} extra · clean needs ${targets.pitch}%`);
    if (result.evenness !== null) {
      row('Evenness', meterState(result.evenness, targets.evenness), bar(result.evenness, targets.evenness), `${result.evenness}%`,
        `Onsets within ±${result.timing_ms} ms of your own steady tempo · clean needs ${targets.evenness}%`);
    }
    if (result.drift_percent !== null) {
      const drift = result.drift_percent;
      const held = Math.abs(drift) <= targets.drift;
      row('Tempo', held ? 'good' : 'short', driftTrack(drift, targets.drift), `${drift > 0 ? '+' : ''}${Math.round(drift)}%`,
        `${held ? 'Held one tempo' : drift > 0 ? 'Sped up' : 'Slowed down'} from the first third of the take to the last · ♩ ${result.played_bpm} overall · clean allows ±${targets.drift}%`);
    }
    if (result.loudness !== null) {
      row('Loudness', meterState(result.loudness, LOUDNESS_GUIDE), bar(result.loudness, LOUDNESS_GUIDE), `${result.loudness}%`,
        'How alike your notes were in loudness. It does not decide a clean take.');
    }
    if (result.sync_ms !== null) {
      const together = Math.max(0, 100 - result.sync_ms / 1.2);
      row('Hands', result.sync_ms <= SYNC_GUIDE ? 'good' : 'short', bar(together, 100 - SYNC_GUIDE / 1.2), `${result.sync_ms} ms`,
        `The hands landed ${result.sync_ms} ms apart on average`);
    }
    if (result.accents !== null) {
      row('Accents', meterState(result.accents, ACCENT_GUIDE), bar(result.accents, ACCENT_GUIDE), `${result.accents}%`,
        'Accented notes that stood out above their neighbours');
    }
    if (result.crossing_ms !== null) {
      row('Crossings', Math.abs(result.crossing_ms) < 40 ? 'good' : 'short', driftTrack(result.crossing_ms / 4, 10),
        `${result.crossing_ms > 0 ? '+' : ''}${result.crossing_ms} ms`, 'How much later than other notes your thumb crossings landed');
    }
    return list;
  }

  timeline(task, result) {
    const rows = result.timeline;
    const figure = element('figure', undefined, 'drill-lanes');
    const flagged = rows.filter(row => row.flag || row.missed).length;
    figure.setAttribute('aria-label', `${rows.length} notes: ${flagged} late, early or missed.`);
    const band = tempoBand(rows, result.targets.drift);
    const loud = loudnessOutliers(rows, task.drill.practice === 'accents');
    const width = rows.length * 10;
    const lane = 28;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${lane * 3}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attributes, parent = svg) => {
      const node = document.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      parent.append(node);
      return node;
    };
    const step = width / rows.length;
    const centre = index => index * step + step / 2;
    // Bar lines, so a problem can be found in the score.
    rows.forEach((row, index) => { if (index && row.bar !== rows[index - 1].bar) add('line', {x1: index * step, x2: index * step, y1: 0, y2: lane * 3, class: 'lane-bar'}); });
    // Tempo: the line of the tempo you held, inside the band around the tempo you opened with.
    if (band) {
      const y = tempo => 3 + (1 - (tempo - band.min) / (band.max - band.min)) * (lane - 6);
      add('rect', {x: 0, width, y: y(band.high), height: y(band.low) - y(band.high), class: 'lane-band'});
      // Each stretch of the line is amber where it leaves the band, so the drift shows where it happened.
      const points = rows.flatMap((row, index) => (row.tempo == null ? [] : [{x: centre(index), y: y(row.tempo), off: row.tempo < band.low || row.tempo > band.high}]));
      points.slice(1).forEach((point, index) => {
        const before = points[index];
        add('line', {x1: before.x, y1: before.y, x2: point.x, y2: point.y, class: before.off || point.off ? 'lane-off' : 'lane-tempo'});
      });
    }
    // Timing: late rises above the line, early dips below it; a cross marks a missed note.
    const middle = lane * 1.5;
    add('line', {x1: 0, x2: width, y1: middle, y2: middle, class: 'lane-zero'});
    const limit = Math.max(200, ...rows.map(row => Math.abs(row.deviation_ms ?? 0)));
    rows.forEach((row, index) => {
      if (row.deviation_ms !== null) {
        const size = Math.max(1, Math.abs(row.deviation_ms) / limit * (lane / 2 - 2));
        add('rect', {x: index * step + 2, width: step - 4, y: row.deviation_ms > 0 ? middle - size : middle, height: size,
          class: row.flag === 'late' ? 'lane-late' : row.flag === 'early' ? 'lane-early' : 'lane-steady'});
      }

    });
    // Loudness: a bar per note, with a line at the typical note.
    const velocities = rows.map(row => row.velocity).filter(value => value != null);
    if (velocities.length) {
      const top = Math.max(...velocities);
      const typical = medianOf(velocities);
      const y = velocity => lane * 3 - 2 - velocity / top * (lane - 6);
      rows.forEach((row, index) => {
        if (row.velocity == null) return;
        add('rect', {x: index * step + 2, width: step - 4, y: y(row.velocity), height: lane * 3 - 2 - y(row.velocity),
          class: loud.has(index) ? 'lane-loud' : 'lane-even'});
      });
      add('line', {x1: 0, x2: width, y1: y(typical), y2: y(typical), class: 'lane-typical'});
    }
    // One hover target per note across all three lanes.
    rows.forEach((row, index) => {
      const hit = add('rect', {x: index * step, width: step, y: 0, height: lane * 3, class: 'lane-hit'});
      const name = pitchName(task.target[row.index].pitch, task.key);
      const timing = row.missed ? 'missed' : row.deviation_ms === null ? null
        : `${Math.abs(row.deviation_ms)} ms ${row.deviation_ms > 0 ? 'late' : 'early'}`;
      add('title', {}, hit).textContent = [`Bar ${row.bar} · ${name}`, timing, row.tempo != null && `♩ ${Math.round(row.tempo)}`,
        row.velocity != null && `loudness ${row.velocity}`].filter(Boolean).join(' · ');
    });
    const labels = element('div', undefined, 'drill-lane-labels');
    labels.append(element('span', 'Tempo'), element('span', 'Timing'), element('span', 'Loudness'));
    labels.children[1].title = 'Above the line: late. Below: early. ✕: missed.';
    const ends = element('div', undefined, 'drill-lane-ends');
    // The summary agrees with the Tempo meter: drift from the first third of the take to the last.
    const drifted = result.drift_percent !== null && Math.abs(result.drift_percent) > result.targets.drift;
    const summary = (text, good) => element('span', text, good ? 'good' : 'short');
    ends.append(band ? summary(`♩${Math.round(band.opening)}→${Math.round(band.closing)}`, !drifted) : element('span'),
      summary(flagged ? `${flagged} off` : 'even', !flagged), summary(loud.size ? `${loud.size} uneven` : 'even', !loud.size));
    const chart = element('div', undefined, 'drill-lane-chart');
    chart.append(svg);
    // Missed notes are marked over the chart, where the stretched drawing cannot distort the cross.
    rows.forEach((row, index) => {
      if (!row.missed) return;
      const mark = element('span', '✕', 'drill-lane-missed');
      mark.style.left = `${100 * (index + 0.5) / rows.length}%`;
      chart.append(mark);
    });
    const bars = element('div', undefined, 'drill-lane-axis');
    rows.forEach((row, index) => {
      if (index && row.bar === rows[index - 1].bar) return;
      const label = element('span', String(row.bar));
      label.style.left = `${100 * index / rows.length}%`;
      bars.append(label);
    });
    chart.append(bars);
    figure.append(labels, chart, ends);
    return figure;
  }

  renderLevels(onTrain) {
    const board = $('drillLevels');
    board.replaceChildren();
    $('drillStreak').textContent = this.streak ? `${this.streak}-day streak` : '';
    for (const group of this.catalog.groups) {
      const section = element('section', undefined, 'drill-level-group');
      section.append(element('h3', group, 'rule-heading'));
      for (const [drill, level] of Object.entries(this.levels).filter(([, item]) => item.group === group)) {
        const card = element('div', undefined, 'drill-level-card');
        const badge = element('b', String(level.level), 'drill-level-badge');
        const body = element('div');
        body.append(element('strong', level.name));
        const track = element('span', undefined, 'xp-track');
        const fill = element('i');
        fill.style.width = `${level.next ? 100 * level.next.done / level.next.keys : 100}%`;
        track.append(fill);
        body.append(track, element('small', level.next
          ? `Level ${level.next.level}: ${level.next.done} of ${level.next.keys} key${level.next.keys > 1 ? 's' : ''} at ${tempoLabel(level.next.tempo.per_beat, level.next.tempo.bpm)}${level.next.hands_together ? ', hands together' : ''}`
          : 'Top level reached'));
        const train = element('button', 'Train', 'quiet-button');
        train.addEventListener('click', () => onTrain(drill));
        card.append(badge, body, train);
        section.append(card);
      }
      board.append(section);
    }
  }

  renderLog(onPick) {
    const list = $('drillLog');
    list.replaceChildren();
    const entries = Object.values(this.progress).sort((a, b) => b.last - a.last);
    if (!entries.length) {
      list.append(element('p', 'Your drills will appear here after your first attempt.', 'setting-help'));
      return;
    }
    for (const entry of entries) {
      const button = element('button', undefined, 'drill-log-row');
      const best = entry.best_tempo ? `steady at ${tempoLabel(entry.best_tempo.per_beat, entry.best_tempo.bpm)}` : 'no steady streak yet';
      const date = new Date(entry.last * 1000).toLocaleDateString([], {month: 'short', day: 'numeric'});
      button.append(element('span', entry.title), element('strong', `try ${tempoLabel(entry.working_tempo.per_beat, entry.working_tempo.bpm)}`),
        element('small', [best, entry.milestone && `meets ${entry.milestone}`, entry.goal && 'top of the ladder',
          `${entry.clean} clean of ${entry.attempts}`, date].filter(Boolean).join(' · ')));
      button.addEventListener('click', () => onPick({...entry.config, practice: 'even'}));
      list.append(button);
    }
  }
}
