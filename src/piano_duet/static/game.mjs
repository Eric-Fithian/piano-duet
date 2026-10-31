import {pitchName} from './learning.mjs';
import {renderLandingHeatmap} from './reading_heatmap.mjs';

const $ = id => document.getElementById(id);
export const PHASE_COLORS = {
  Beginner: 'var(--green)', Developing: 'var(--cyan)', Intermediate: 'var(--yellow)', Advanced: 'var(--red)', Expert: 'var(--pink)',
};
const HANDS = {right: 'Right hand', left: 'Left hand', both: 'Both hands', treble: 'Right hand', bass: 'Left hand', grand: 'Both hands'};
const number = value => value.toLocaleString('en-US');
export const TEMPO_LIMITS = [30, 200];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function replay(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

export function scoreRank(accuracy) {
  return accuracy === 100 ? 'Perfect' : accuracy >= 90 ? 'Great' : accuracy >= 75 ? 'Good' : 'Complete';
}

export function attackStates(progress) {
  return progress.attacks.map(attack => {
    const first = attack.indices[0];
    if (first === progress.index) return 'now';
    if (first > progress.index) return '';
    return attack.indices.some(index => progress.mistakes.has(index)) ? 'fixed' : 'done';
  });
}

export function renderLevel(xp) {
  $('levelNumber').textContent = xp.level;
  $('levelXp').textContent = `${number(xp.into)} / ${number(xp.needed)}`;
  $('levelFill').style.width = `${100 * xp.into / xp.needed}%`;
  $('openProfile').setAttribute('aria-label', `Level ${xp.level}, ${xp.into} of ${xp.needed} XP. Open progress.`);
}

export function renderReadingHud(task, progress, curriculum, sessionXp, replaying) {
  const stage = curriculum?.path.find(item => item.number === task.reading.stage_number);
  const node = $('hudStageNumber');
  node.textContent = String(task.reading.stage_number);
  node.style.setProperty('--phase', PHASE_COLORS[stage?.phase] || PHASE_COLORS.Beginner);
  const introduction = task.reading.introduce ?? null;
  $('hudStageLabel').textContent = introduction !== null ? pitchName(introduction) : stage?.label || task.title;
  $('hudNew').hidden = introduction === null;
  $('hudHand').textContent = HANDS[task.reading.hand];
  $('hudReplay').hidden = !replaying;
  if (replaying && curriculum) $('hudReplay').title = `Back to stage ${curriculum.number}`;
  $('hudBeat').hidden = !task.reading.rhythm_required;
  $('hudTempo').hidden = !task.reading.rhythm_required;
  if (task.reading.rhythm_required) {
    const minimum = task.reading.minimum_bpm ?? 0;
    $('tempoValue').textContent = progress.tempo;
    $('tempoDown').disabled = progress.tempo <= Math.max(TEMPO_LIMITS[0], minimum);
    $('tempoDown').title = minimum && progress.tempo <= minimum ? `Stage ${task.reading.stage_number} needs at least ${minimum} BPM` : 'Slower (←)';
    $('tempoUp').disabled = progress.tempo >= TEMPO_LIMITS[1];
    $('tempoUp').title = 'Faster (→)';
  }
  const states = attackStates(progress);
  const notes = $('hudNotes');
  if (notes.children.length !== states.length) notes.replaceChildren(...states.map(() => element('i')));
  states.forEach((state, i) => { notes.children[i].className = state; });
  notes.setAttribute('aria-label', `${states.filter(state => state === 'done' || state === 'fixed').length} of ${states.length} notes played`);
  const streak = $('hudStreak');
  const value = streak.querySelector('b');
  if (Number(value.textContent) < progress.streak) replay(value, 'pop');
  value.textContent = progress.streak;
  streak.classList.toggle('hot', progress.streak >= 5 && progress.streak < 15);
  streak.classList.toggle('blazing', progress.streak >= 15);
  $('hudXp').querySelector('b').textContent = number(sessionXp);
  const wrong = $('readingFeedback');
  const heard = progress.wrong.map(pitch => pitchName(pitch, task.key)).join(' + ');
  if (heard && wrong.textContent !== `✕ ${heard}`) replay(wrong, 'hud-wrong');
  wrong.textContent = heard ? `✕ ${heard}` : '';
  wrong.hidden = !heard;
}

let toastTimer = null;
export function showXpToast(task, result, xp, onOpen) {
  const toast = $('xpToast');
  clearTimeout(toastTimer);
  toast.classList.remove('leaving');
  toast.replaceChildren();
  const head = element('div', 'xp-toast-head');
  const introduction = task.reading.introduce ?? null;
  const {score, rhythm} = result.assessment;
  head.append(element('span', 'xp-toast-label', introduction !== null ? 'New note' : scoreRank(score.score)));
  const value = element('span', 'xp-toast-score', introduction !== null ? pitchName(introduction) : `${score.score}%`);
  if (introduction === null && task.reading.rhythm_required && rhythm.accuracy !== null) value.append(element('small', '', `♩ ${rhythm.accuracy}%`));
  head.append(value);
  const list = element('ul');
  result.xp.items.forEach((item, i) => {
    const row = element('li', item.xp < 0 ? 'negative' : '');
    row.style.setProperty('--i', i);
    const count = item.count === undefined ? '' : item.id === 'rhythm' ? ` ${item.count}%` : ` ×${item.count}`;
    row.append(element('span', '', `${item.label}${count}`), element('b', '', `${item.xp > 0 ? '+' : ''}${number(item.xp)}`));
    list.append(row);
  });
  const total = element('div', 'xp-toast-total');
  const amount = element('b', '', '+0');
  const track = element('span', 'xp-track');
  const fill = element('i');
  const before = Math.max(0, xp.into - result.xp.total);
  fill.style.width = `${100 * before / xp.needed}%`;
  track.append(fill);
  total.append(amount, track);
  toast.append(head, list, total);
  toast.hidden = false;
  toast.onclick = onOpen;
  const delay = 200 + result.xp.items.length * 110;
  const start = performance.now() + delay;
  const count = now => {
    const fraction = Math.min(1, Math.max(0, (now - start) / 600));
    amount.textContent = `+${number(Math.round(result.xp.total * fraction))} XP`;
    if (fraction < 1) requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
  setTimeout(() => { fill.style.width = `${100 * xp.into / xp.needed}%`; }, delay);
  toastTimer = setTimeout(() => {
    toast.classList.add('leaving');
    toastTimer = setTimeout(() => { toast.hidden = true; }, 300);
  }, 5200);
}

const banners = [];
export function showBanner({kind, caption, title, detail}) {
  banners.push({kind, caption, title, detail});
  if (banners.length === 1) nextBanner();
}
function nextBanner() {
  const item = banners[0];
  if (!item) return;
  const banner = $('banner');
  banner.className = `banner ${item.kind}`;
  banner.replaceChildren(element('span', '', item.caption), element('strong', '', item.title));
  if (item.detail) banner.append(element('small', '', item.detail));
  banner.hidden = false;
  replay(banner, 'banner');
  setTimeout(() => {
    banner.hidden = true;
    banners.shift();
    nextBanner();
  }, 2800);
}

function goal(label, value, target, met, bar) {
  const row = element('div', `goal${met ? ' met' : ''}`);
  const text = element('b', '', value);
  if (target) text.append(element('small', '', ` / ${target}`));
  row.append(element('span', '', label), text, bar);
  return row;
}
function segments(filled, total) {
  const bar = element('div', 'segments');
  for (let i = 0; i < total; i++) bar.append(element('i', i < filled ? 'on' : ''));
  return bar;
}
function meter(value, target, scale = 100) {
  const bar = element('div', 'meter-bar');
  const fill = element('i');
  fill.style.width = `${Math.min(100, 100 * (value ?? 0) / scale)}%`;
  const mark = element('em');
  mark.style.left = `${100 * target / scale}%`;
  bar.append(fill, mark);
  return bar;
}
const percent = value => value === null ? '—' : `${value}%`;
function stageObjectives(stage) {
  const list = element('div', 'objectives');
  for (const group of stage.groups) {
    const card = element('div', `objective${group.ready ? ' met' : ''}`);
    card.append(element('h4', '', HANDS[group.hand]));
    card.append(goal('Fresh scores', `${Math.min(group.samples, group.required)}/${group.required}`, null, group.samples >= group.required, segments(group.samples, group.required)));
    card.append(goal('First-try pitch', percent(group.accuracy), '90%', group.accuracy >= 90, meter(group.accuracy, 90)));
    if (stage.rhythm_required) card.append(goal('Rhythm', percent(group.rhythm), '80%', group.rhythm >= 80 && group.rhythm_samples >= group.required, meter(group.rhythm, 80)));
    if (stage.minimum_bpm) card.append(goal('Tempo', group.bpm === null ? '—' : String(group.bpm), `${stage.minimum_bpm} BPM`, group.bpm >= stage.minimum_bpm, meter(group.bpm, stage.minimum_bpm, stage.minimum_bpm * 1.5)));
    list.append(card);
  }
  const extras = [['Notes established', stage.notes, stage.required_notes], ['Keys', stage.keys, stage.required_keys], ['Time signatures', stage.meters, stage.required_meters]]
    .filter(([, , need]) => need > 1);
  if (extras.length) {
    const card = element('div', `objective${extras.every(([, have, need]) => have >= need) ? ' met' : ''}`);
    card.append(element('h4', '', 'Coverage'));
    for (const [label, have, need] of extras) card.append(goal(label, `${Math.min(have, need)}/${need}`, null, have >= need, segments(have, need)));
    list.append(card);
  }
  return list;
}

function renderPath(curriculum, playing, onPlay) {
  const path = $('readingPath');
  path.replaceChildren();
  $('pathCount').textContent = `${curriculum.completed}/${curriculum.total}`;
  const detail = stage => {
    const line = $('pathDetail');
    line.replaceChildren(element('b', '', `${String(stage.number).padStart(2, '0')} ${stage.label}`), `${stage.description} `);
    line.append(element('span', '', stage.status === 'Complete' ? '· Cleared' : stage.status === 'Current' ? '· In progress' : '· Locked'));
    if (stage.status !== 'Ahead' && stage.number !== playing) {
      const play = element('button', 'primary path-play', stage.status === 'Current' ? 'Back to current' : `Replay stage ${stage.number}`);
      play.addEventListener('click', () => onPlay(stage.status === 'Current' ? null : stage.number));
      line.append(play);
    }
    for (const dot of path.querySelectorAll('.stage-dot')) dot.setAttribute('aria-pressed', dot.dataset.stage === stage.id);
  };
  const phases = [...new Set(curriculum.path.map(stage => stage.phase))];
  for (const phase of phases) {
    const stages = curriculum.path.filter(stage => stage.phase === phase);
    const done = stages.filter(stage => stage.status === 'Complete').length;
    const item = element('li', 'phase');
    item.style.setProperty('--phase', PHASE_COLORS[phase]);
    item.style.setProperty('--count', stages.length);
    item.style.setProperty('--done', `${stages.length > 1 ? 100 * Math.max(0, done - (done === stages.length ? 1 : 0)) / (stages.length - 1) : 0}%`);
    const nodes = element('div', 'phase-nodes');
    for (const stage of stages) {
      const dot = element('button', `stage-dot ${stage.status === 'Complete' ? 'complete' : stage.status === 'Current' ? 'current' : ''}${stage.number === playing ? ' playing' : ''}`);
      dot.dataset.stage = stage.id;
      dot.setAttribute('aria-label', `Stage ${stage.number}: ${stage.label}, ${stage.status}`);
      dot.append(element('span', '', stage.number));
      dot.addEventListener('click', () => detail(stage));
      nodes.append(dot);
    }
    item.append(element('span', 'phase-name', phase), nodes);
    path.append(item);
  }
  detail(curriculum.path[playing - 1]);
}

function renderStage(curriculum) {
  const card = $('readingStage');
  const current = curriculum.path.find(stage => stage.id === curriculum.current);
  card.style.setProperty('--phase', PHASE_COLORS[current.phase]);
  const head = element('div', 'stage-card-head');
  const node = element('span', 'stage-node', String(current.number).padStart(2, '0'));
  node.style.setProperty('--phase', PHASE_COLORS[current.phase]);
  const title = element('div');
  title.append(element('span', '', current.phase), element('strong', '', current.label));
  head.append(node, title);
  card.replaceChildren(head, element('p', '', current.description), stageObjectives(current));
  const upcoming = curriculum.path[current.number];
  const next = element('p', 'stage-next');
  if (curriculum.finished) next.append(element('b', '', 'All stages cleared'));
  else if (upcoming) next.append(element('b', '', 'Next ▸'), upcoming.label);
  card.append(next);
}

function renderRecent(history, onReview) {
  const recent = $('readingHistory');
  recent.replaceChildren();
  for (const round of history) {
    const bar = element('button', 'recent-score');
    bar.style.setProperty('--accuracy', `${Math.max(4, round.accuracy)}%`);
    bar.style.setProperty('--tone', round.accuracy >= 90 ? 'var(--green)' : round.accuracy >= 75 ? 'var(--gold)' : 'var(--red)');
    const date = new Date(round.at * 1000).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
    bar.title = `Stage ${round.stage} · ${round.accuracy}% first try${round.rhythm === null ? '' : ` · ♩ ${round.rhythm}%`} · +${round.xp} XP · ${date}`;
    bar.setAttribute('aria-label', `Review: ${bar.title}`);
    bar.append(element('small', '', `${round.accuracy}`));
    bar.addEventListener('click', () => onReview(round.id));
    recent.append(bar);
  }
}

function renderSkills(skills) {
  const tiles = $('readingSkills');
  tiles.replaceChildren();
  for (const skill of skills) {
    const tile = element('div', 'skill-tile');
    tile.append(element('span', '', skill.label), element('strong', '', skill.accuracy === null ? '—' : `${skill.accuracy}%`));
    const hands = element('div', 'hand-bars');
    for (const [clef, label] of [['treble', 'RH'], ['bass', 'LH']]) {
      const row = element('div');
      const bar = element('i');
      bar.style.setProperty('--value', `${skill.hands[clef].accuracy ?? 0}%`);
      row.title = `${HANDS[clef]}: ${skill.hands[clef].accuracy ?? '—'}%`;
      row.append(element('span', '', label), bar);
      hands.append(row);
    }
    tile.append(hands);
    tiles.append(tile);
  }
}

function renderFluency(hands) {
  renderLandingHeatmap($('readingLandingMap'), hands);
  const fluency = $('readingFluency');
  fluency.replaceChildren();
  for (const clef of ['treble', 'bass']) {
    const stats = hands[clef].fluency;
    const card = element('div', 'fluency-hand');
    card.append(element('h4', '', HANDS[clef]));
    if (!stats.samples) card.append(element('strong', '', '—'));
    else {
      card.append(element('strong', '', `${stats.extra_seconds.toFixed(1)} s`), element('span', '', ' extra pause at a position change'));
      card.append(element('small', '', `${stats.extra_beats.toFixed(1)} beats · ${stats.bpm} BPM · ${stats.recent_samples} changes${stats.previous_beats === null ? '' : ` · was ${stats.previous_beats.toFixed(1)} beats`}`));
    }
    fluency.append(card);
  }
}

export function renderCareer(progress, onReview, replay, onPlay) {
  const {xp, curriculum} = progress;
  $('careerLevel').textContent = xp.level;
  $('careerXp').textContent = `${number(xp.into)} / ${number(xp.needed)} XP`;
  $('careerFill').style.width = `${100 * xp.into / xp.needed}%`;
  const stats = $('careerStats');
  stats.replaceChildren();
  for (const [label, value] of [['Total XP', number(xp.xp)], ['Scores', number(progress.rounds)], ['Notes', number(progress.notes)],
    ['First try', progress.accuracy === null ? '—' : `${progress.accuracy}%`], ['Stages', `${curriculum.completed}/${curriculum.total}`]]) {
    const item = element('div');
    item.append(element('dt', '', label), element('dd', '', value));
    stats.append(item);
  }
  renderPath(curriculum, replay ?? curriculum.number, onPlay);
  renderStage(curriculum);
  renderRecent(progress.history, onReview);
  renderSkills(progress.skills);
  renderFluency(progress.hands);
}
