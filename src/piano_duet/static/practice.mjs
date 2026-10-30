import {pitchName} from './learning.mjs';

const $ = id => document.getElementById(id);
let localService = null;

export function setLocalService(service) {
  localService = service;
}

export function localFetch(path, options) {
  return localService && (path.startsWith('/api/') || path.startsWith('/samples/')) ? localService.fetch(path, options) : fetch(path, options);
}

export async function localRequest(path, body, method = 'POST') {
  const response = await localFetch(path, body === undefined ? {} : {
    method, headers: {'Content-Type': 'application/json', 'X-Duet-Client': '1'},
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // A crash in the server answers in plain text, not the JSON of a refused request.
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`The local server failed on ${path} (${response.status}). Check the Terminal running Piano Duet for details.`);
    }
    const data = await response.json();
    const detail = Array.isArray(data.detail) ? data.detail.map(item => `${item.loc.join('.')}: ${item.msg}`).join('; ') : data.detail;
    throw new Error(typeof detail === 'string' ? detail : 'The local learning request was invalid.');
  }
  return response.json();
}

export function levelLabel(skill) {
  return skill.level === null ? 'Untested' : skill.level === 0 ? 'Exploring' : `Level ${skill.level}`;
}

export function evidenceLabels(assessment) {
  return [...new Set(assessment.evidence.filter(item => item.facet === 'all').map(item => item.label))];
}

export class PracticeCycle {
  constructor() { this.reset(); }
  reset() {
    this.task = null;
    this.result = null;
    this.attemptId = null;
    this.completed = false;
    this.excluded = false;
  }
  acceptTask(task) {
    if (!task.id || !task.target?.length) throw new Error('The exercise has no playable target.');
    this.reset();
    this.task = task;
  }
  acceptAssessment(event) {
    if (!this.task) throw new Error('There is no exercise to assess.');
    this.result = event.assessment;
    this.attemptId = event.id;
    this.completed = event.assessment.score !== null;
  }
  get visible() { return Boolean(this.completed || this.task?.context.notation_visible || this.task?.context.reveals); }
  get canPlay() {
    return Boolean(this.task && !this.completed && (this.task.family !== 'ear' || this.task.context.hearings));
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function renderPractice(cycle) {
  const task = cycle.task;
  if (!task) return;
  $('practicePanel').classList.toggle('completed', cycle.completed);
  $('practicePanel').classList.toggle('has-result', Boolean(cycle.result));
  $('practicePanel').classList.toggle('introduction', Boolean(task.context.introduction));
  $('practicePurpose').textContent = `${task.purpose} · ${task.family}`;
  $('practiceChallenge').textContent = task.reading ? `${task.reading.hand.toUpperCase()} HAND · ${task.reading.clef.toUpperCase()} CLEF`
    : task.drill ? `${task.drill.group} · ${task.cue}`.toUpperCase() : `Stage ${task.challenge} of 5`;
  $('practiceTitle').textContent = task.title;
  $('practiceInstruction').textContent = task.instruction;
  $('practiceSummary').textContent = task.instruction;
  $('practiceCue').textContent = task.cue;
  $('practiceCue').hidden = !task.cue;
  $('practiceReason').textContent = task.reason;
  $('practiceLesson').textContent = task.lesson;
  $('hearPractice').textContent = task.family === 'ear' ? 'Hear melody' : task.reading ? 'Hear this score' : task.drill ? '▶ Hear it played' : 'Hear example';
  $('practiceBeat').hidden = !task.bpm;
  $('revealPractice').hidden = cycle.visible;
  $('practiceResult').hidden = !cycle.result;
  if (cycle.result) {
    const {score, feedback} = cycle.result;
    $('practiceScore').textContent = score ? `${score.score} / 100` : 'Try again';
    $('practiceFeedback').textContent = feedback;
    $('practiceFeedbackDetail').textContent = feedback;
    $('practiceScoreDetail').textContent = score?.rhythm_accuracy === null
      ? 'Approximate microphone pitch score. Check the heard notes if this looks wrong.'
      : 'Approximate microphone score: pitches and relative rhythm. Controlled speed is tracked separately.';
    const labels = evidenceLabels(cycle.result);
    $('practiceEvidence').textContent = cycle.excluded ? 'Excluded from your profile.' : labels.length
      ? `Evidence for: ${labels.join(' · ')}.` : 'Saved without changing your skill levels.';
    $('excludePractice').textContent = cycle.excluded ? 'Include this attempt again' : 'The microphone misheard me — exclude this attempt';
  }
}

export function renderProfile(profile, onSelect) {
  $('profileSummary').textContent = `${profile.included_attempts} included attempt${profile.included_attempts === 1 ? '' : 's'} · ${profile.notes} notes · ${profile.days} practice day${profile.days === 1 ? '' : 's'}. Saved on this Mac.`;
  $('historyCount').textContent = `(${profile.attempts})`;
  const cards = $('skillCards');
  cards.replaceChildren();
  for (const family of profile.families) {
    const card = element('article', undefined, 'skill-card');
    card.append(element('h3', family));
    if (family === 'Creating') {
      card.append(element('strong', `${profile.creative_phrases} musical ideas`));
      card.append(element('p', 'Explore in Duet or Variations. Your ideas become part of your history; originality has no right-answer score.'));
    } else {
      for (const skill of profile.skills.filter(skill => skill.family === family)) {
        const details = element('details', undefined, 'skill-detail');
        const summary = element('summary');
        summary.append(element('span', skill.label), element('strong', levelLabel(skill)));
        details.append(summary);
        details.append(element('p', skill.attempts
          ? `${skill.accuracy}% recent accuracy · ${skill.attempts} assessed attempts · ${skill.confidence.toLowerCase()}.`
          : 'No assessed evidence yet. This is an unexplored area, not a weakness.'));
        if (skill.conditions.length) {
          if (skill.coverage.keys) details.append(element('p', `${skill.coverage.keys} of 24 major / natural-minor key contexts assessed.`));
          if (skill.coverage.pitches) details.append(element('p', `${skill.coverage.pitches} of 88 piano notes assessed. Other notes are still unexplored.`));
          const list = element('ul', undefined, 'skill-conditions');
          for (const condition of skill.conditions) {
            list.append(element('li', `${condition.label} — ${condition.accuracy}% · ${levelLabel(condition)} · ${condition.attempts} attempts`));
          }
          details.append(list);
        }
        card.append(details);
      }
    }
    cards.append(card);
  }
  const history = $('attemptList');
  history.replaceChildren();
  if (!profile.recent.length) history.append(element('p', 'Your first performance will appear here with its prompt and the notes we heard.'));
  for (const attempt of profile.recent) {
    const button = element('button', undefined, 'history-attempt');
    const date = new Date(attempt.created_at * 1000).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
    button.append(element('span', attempt.title), element('small', `${date} · ${attempt.note_count} notes${attempt.excluded ? ' · excluded' : ''}`));
    button.append(element('strong', attempt.assessment.score ? `${attempt.assessment.score.score}%` : 'Saved'));
    button.addEventListener('click', () => onSelect(attempt.id));
    history.append(button);
  }
}

export function beatGroups(meter) {
  const [numerator, denominator] = meter.split('/').map(Number);
  if (meter === '7/8') return [1, 1, 1.5];
  if (denominator === 8 && numerator % 3 === 0) return Array(numerator / 3).fill(1.5);
  return Array(numerator).fill(4 / denominator);
}

export function renderAttempt(attempt, onExclude) {
  const panel = $('attemptDetail');
  panel.replaceChildren();
  panel.hidden = false;
  panel.append(element('h3', attempt.prompt.title));
  panel.append(element('p', attempt.prompt.instruction || 'An open musical phrase, without a prescribed answer.'));
  const context = attempt.context;
  panel.append(element('p', `${context.family} · ${context.notation_visible ? 'score shown from the start' : 'score initially hidden'} · ${context.hearings} listens · ${context.reveals} reveals · ${context.hints} help views · ${context.familiar ? 'familiar material' : 'new material'}`, 'attempt-context'));
  panel.append(element('p', attempt.assessment.feedback));
  for (const change of attempt.assessment.fluency || []) {
    const label = `${change.hand === 'left' ? 'Left' : 'Right'} hand · ${pitchName(change.pitch, attempt.prompt.key)}${change.finger ? ` · suggested finger ${change.finger}` : ''}`;
    const arrival = change.arrival_seconds === null ? `Landing untimed: ${change.arrival_reason}` : `${change.arrival_seconds.toFixed(1)} s to land.`;
    const extra = change.extra_seconds === null ? `Extra pause unmeasured: ${change.reason}`
      : `${change.extra_seconds.toFixed(1)} s extra pause (${change.extra_beats.toFixed(1)} beats), at ${Math.round(change.bpm)} BPM.`;
    panel.append(element('p', `${label}: ${arrival} ${extra}`));
  }
  const quality = attempt.assessment.quality;
  panel.append(element('p', `Recognition: ${quality.usable ? 'sufficient onset support' : 'uncertain'}. ${quality.reason}.`, 'attempt-context'));
  const labels = evidenceLabels(attempt.assessment);
  panel.append(element('p', attempt.excluded ? 'Excluded from all skill calculations.' : labels.length ? `Shared evidence: ${labels.join(', ')}.` : 'No skill rating inferred.'));
  if (attempt.assessment.observations.length) {
    const scroll = element('div', undefined, 'attempt-observations');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Expected and heard notes');
    const table = element('table');
    const head = element('thead');
    const header = element('tr');
    for (const name of ['Note', 'Expected', 'Heard', 'Result']) {
      const th = element('th', name); th.scope = 'col'; header.append(th);
    }
    head.append(header); table.append(head);
    const body = element('tbody');
    for (const observation of attempt.assessment.observations) {
      const row = element('tr');
      for (const text of [String(observation.index + 1), pitchName(observation.expected, attempt.prompt.key),
        observation.heard.map(pitch => pitchName(pitch, attempt.prompt.key)).join(' + ') || '—', context.interaction === 'step_by_step'
          ? (observation.matched ? 'First try' : 'Corrected') : observation.matched ? 'Matched' : 'Check this note']) row.append(element('td', text));
      body.append(row);
    }
    table.append(body); scroll.append(table); panel.append(scroll);
  }
  const notes = element('details');
  notes.append(element('summary', `All ${attempt.notes.length} recognized notes`));
  notes.append(element('p', attempt.notes.map(n => `${pitchName(n.pitch)} at ${n.start.toFixed(2)}s (${n.duration.toFixed(2)}s)`).join(' · ') || 'No notes recognized.'));
  panel.append(notes);
  const button = element('button', attempt.excluded ? 'Include in my profile' : 'Exclude from my profile', 'secondary');
  button.addEventListener('click', () => onExclude(attempt.id, !attempt.excluded));
  panel.append(button);
}
