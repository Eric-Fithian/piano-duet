const NS = 'http://www.w3.org/2000/svg';

function svgElement(name, attributes) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

export function stageWindow(path, current) {
  if (!Number.isInteger(current) || current < 1 || current > path.length) throw new Error('Invalid current stage.');
  const start = Math.min(Math.floor((current - 1) / 5) * 5, Math.max(0, path.length - 5));
  return path.slice(start, start + 5);
}

export function stagePath(path, current) {
  const stages = stageWindow(path, current);
  const svg = svgElement('svg', {viewBox: '0 0 130 24', class: 'progress-stage-path', role: 'img',
    'aria-label': `Stages ${stages[0].number} to ${stages.at(-1).number} of ${path.length}. ${stages.map(stage => `Stage ${stage.number} ${stage.status === 'Ahead' ? 'locked' : stage.status.toLowerCase()}`).join(', ')}`});
  stages.forEach((stage, index) => {
    const group = svgElement('g', {transform: `translate(${13 + index * 26} 12)`});
    const earned = stage.status === 'Complete';
    group.append(svgElement('ellipse', {rx: 9, ry: 6.5, transform: 'rotate(-22)', class: `progress-node${earned ? ' earned' : ''}${stage.number === current ? ' current' : ''}`}));
    if (earned) group.append(svgElement('path', {d: 'M-4 0l3 3 5-6', class: 'progress-check'}));
    svg.append(group);
  });
  return svg;
}

export function levelRing(xp) {
  if (!(xp.needed > 0) || xp.into < 0 || xp.into > xp.needed) throw new Error('Invalid XP progress.');
  const svg = svgElement('svg', {viewBox: '0 0 32 32', class: 'progress-level-ring', 'aria-hidden': 'true'});
  svg.append(svgElement('circle', {cx: 16, cy: 16, r: 13, class: 'progress-ring-track'}));
  svg.append(svgElement('circle', {cx: 16, cy: 16, r: 13, pathLength: 100, class: 'progress-ring-fill',
    'stroke-dasharray': `${100 * xp.into / xp.needed} 100`, style: `--ring-fill: ${100 * xp.into / xp.needed}`, transform: 'rotate(-90 16 16)'}));
  return svg;
}

export function streakBeam(streak) {
  if (!Number.isInteger(streak) || streak < 0) throw new Error('Invalid streak.');
  const count = Math.min(4, Math.max(1, streak));
  const svg = svgElement('svg', {viewBox: `0 0 ${count * 10 + 5} 24`, class: 'progress-streak-beam',
    style: `--beam-width: ${count * 10 + 5}`, 'aria-hidden': 'true'});
  if (count > 1) svg.append(svgElement('path', {d: `M8 4 L${count * 10 + 2} 1 v4 L8 8 Z`, class: 'progress-beam'}));
  for (let i = 0; i < count; i++) {
    const x = 8 + i * 10;
    svg.append(svgElement('path', {d: `M${x} 5v12`, class: 'progress-stem'}));
    svg.append(svgElement('ellipse', {cx: x - 3, cy: 18, rx: 4, ry: 2.8, transform: `rotate(-22 ${x - 3} 18)`, class: 'progress-beam'}));
  }
  return svg;
}

function nextGoal(stage) {
  const group = stage.groups?.find(item => !item.ready);
  if (group) {
    const hand = {treble: 'right-hand', bass: 'left-hand', grand: 'hands-together'}[group.hand];
    if (!hand) throw new Error(`Unknown reading hand ${group.hand}`);
    if (group.samples < group.required) {
      const remaining = group.required - group.samples;
      return `${remaining} more fresh ${hand} ${remaining === 1 ? 'score' : 'scores'}`;
    }
    if (group.accuracy === null || group.accuracy < 90) return `90% first-try pitch in ${hand} scores`;
    if (stage.rhythm_required && (group.rhythm_samples < group.required || group.rhythm === null || group.rhythm < 80)) return `80% rhythm in ${hand} scores`;
    if (stage.minimum_bpm && (group.bpm === null || group.bpm < stage.minimum_bpm)) return `${stage.minimum_bpm} BPM in ${hand} scores`;
  }
  if (stage.required_notes > stage.notes) return 'Establish the notes in both hands';
  if (stage.required_keys > stage.keys) return 'Practice in more keys';
  if (stage.required_meters > stage.meters) return 'Practice more time signatures';
  return stage.label;
}

export function resultSummary(task, result, before, after) {
  const score = result.assessment.score;
  if (!after) return {milestone: false, title: 'Score complete', detail: `${score.first_try} of ${score.total} notes first try`,
    xp: null, mistake: result.assessment.observations.find(row => !row.matched) ?? null};
  const cleared = after.curriculum.path.find(stage => stage.number === task.reading.stage_number)?.status === 'Complete'
    && before.curriculum.path.find(stage => stage.number === task.reading.stage_number)?.status !== 'Complete';
  const nextNumber = task.reading.stage_number < before.curriculum.number ? task.reading.stage_number : after.curriculum.number;
  const next = after.curriculum.path.find(stage => stage.number === nextNumber);
  return {
    milestone: cleared || after.xp.level > before.xp.level,
    title: cleared ? `Stage ${task.reading.stage_number} complete` : 'Score complete',
    detail: `${score.first_try} of ${score.total} notes first try${next ? ` · Next: ${cleared ? next.label : nextGoal(next)}` : ''}`,
    xp: result.xp.total + Math.max(0, after.xp.xp - before.xp.xp - result.xp.total),
    mistake: result.assessment.observations.find(row => !row.matched) ?? null,
  };
}
