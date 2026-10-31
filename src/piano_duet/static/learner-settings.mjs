const KEYS = ['piano-duet.note-confidence', 'piano-duet.reading-tempo', 'piano-duet.drill-flow', 'piano-duet.drill',
  'piano-duet.mode', 'piano-duet.pause', 'piano-duet.length', 'piano-duet.difficulty', 'piano-duet.temperature',
  'piano-duet.surprise', 'piano-duet.scoreTempo', 'piano-duet.scoreBpm', 'piano-duet.scoreMeter', 'piano-duet.scoreAccidentals',
  'piano-duet.autoReply.practice', 'piano-duet.autoReply.reading', 'piano-duet.autoReply.drills',
  'piano-duet.autoReply.library', 'piano-duet.autoReply.duet', 'piano-duet.autoReply.learning'];
let store;
let values = new Map();

export async function initializeLearnerSettings(eventLog) {
  store = eventLog;
  await refreshLearnerSettings();
  for (const key of KEYS) {
    const local = localStorage.getItem(key);
    if (!values.has(key) && local !== null) await writeLearnerSetting(key, local);
  }
}

export async function refreshLearnerSettings() {
  if (!store) return;
  const next = new Map();
  for (const event of await store.list()) {
    if (event.kind !== 'setting') continue;
    const {key, value} = event.payload;
    if (KEYS.includes(key) && typeof value === 'string') next.set(key, value);
  }
  values = next;
  for (const [key, value] of values) localStorage.setItem(key, value);
}

export function readLearnerSetting(key) {
  if (!KEYS.includes(key)) throw new Error(`Unknown learner setting: ${key}`);
  return values.get(key) ?? localStorage.getItem(key);
}

export async function writeLearnerSetting(key, value) {
  if (!KEYS.includes(key) || typeof value !== 'string') throw new Error(`Invalid learner setting: ${key}`);
  if ((store ? values.get(key) : localStorage.getItem(key)) === value) return;
  values.set(key, value);
  localStorage.setItem(key, value);
  if (store) await store.append('setting', {key, value});
}
