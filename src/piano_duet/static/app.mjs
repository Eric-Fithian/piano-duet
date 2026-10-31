import {AttackCounter, PhraseDetector, PianoSound, captureAllowed, capturePerformanceTime, readEvents} from './audio.mjs';
import {ScoreView} from './score_view.mjs';
import {LearningCycle, pitchName, renderAnalysis} from './learning.mjs';
import {PracticeCycle, localFetch, localRequest, renderPractice, renderProfile, renderAttempt, beatGroups} from './practice.mjs';
import {ReadingStream} from './reading.mjs';
import {TEMPO_LIMITS, renderCareer, renderLevel, renderReadingHud, renderReadingResult, showBanner} from './game.mjs';
import {currentOrdinal, renderLibrary, renderSongHud, sessionAccuracy} from './library.mjs';
import {DrillPicker, attackPlan, followPosition, heardAttacks, planSession, playedGap, streakText, takeEnded, tempoLabel} from './drills.mjs';
import {METERS, SongEditor, musicalKey} from './song_editor.mjs';
import {readLearnerSetting, refreshLearnerSettings, writeLearnerSetting} from './learner-settings.mjs';
import {ENABLED_MODES} from './enabled_modes.mjs';
import {setupAppearance} from './appearance.mjs';

const $ = id => document.getElementById(id);
const appearance = setupAppearance({root: document.documentElement, theme: $('appearanceTheme'), night: $('nightPage'), storage: localStorage, system: matchMedia('(prefers-color-scheme: dark)')});
const ALL_MODES = ['practice', 'reading', 'drills', 'library', 'duet', 'learning'];
const EMPTY_SCORE = '<span aria-hidden="true">𝄞</span><p>Start with a few notes.</p><small>Your music will appear here.</small>';
// What each part of the app shows on top of the music. The player's own layout, zoom, look-ahead and following
// are remembered separately for each part; `scale` is its staff size at 100% zoom.
const SCORE_VIEWS = {
  reading: {scale: 1.8, cursor: true, feedback: true, heard: true, pace: true, focus: true, barNumbers: 'all'},
  library: {scale: 1.05, cursor: true, feedback: true, heard: true},
  editor: {scale: 1.05, preferences: 'library', settings: ['layout', 'zoom']},
  drills: {scale: 1.25, sounding: true},
  practice: {scale: 1.15, sounding: true, headings: true, followNewest: true, empty: EMPTY_SCORE},
  duet: {scale: 1, sounding: true, headings: true, followNewest: true, empty: EMPTY_SCORE},
  learning: {scale: 1, sounding: true, headings: true, followNewest: true, empty: EMPTY_SCORE},
};
const sheet = new ScoreView($('sheetMusic'));
$('scoreControlsSlot').append(sheet.controls);
sheet.controlsToggle.setAttribute('aria-controls', 'scoreOptions');
$('scoreOptions').append(...[...sheet.controls.children].filter(node => node !== sheet.controlsToggle), sheet.menu, sheet.resumeButton);
$('scoreOptions').addEventListener('pointerdown', event => event.stopPropagation());
$('listenSlot').append($('hudListen'), $('drillListen'));
$('drillMore').before($('drillDetails'));
sheet.onError = error => {
  console.error(error);
  $('scoreError').textContent = `Sheet music could not render: ${error.message}`;
  $('scoreError').hidden = false;
};
sheet.use(ENABLED_MODES[0], SCORE_VIEWS[ENABLED_MODES[0]]);
window.addEventListener('resize', () => sheet.relayout());
screen.orientation?.addEventListener('change', () => sheet.relayout());
window.visualViewport?.addEventListener('resize', () => sheet.relayout());
const context = new AudioContext();
const piano = new PianoSound(context);
const detector = new PhraseDetector();
let microphone = null;
let inputContext = null;
let capture = null;
let controller = null;
let ready = false;
let busy = false;
let epoch = 0;
let calibrating = 0;
let noiseSamples = [];
let latestLevel = 0;
let resumeAt = Infinity;
let resumeAtPerformance = -Infinity;
let playbackStart = null;
let playbackEnd = 0;
let replyOffset = 0;
let session = crypto.randomUUID();
let transcript = [];
let heard = [];
let reply = [];
let turn = 0;
let exchangeOffset = 0;
let lateNotes = 0;
let mode = ENABLED_MODES[0];
const learning = new LearningCycle();
const practice = new PracticeCycle();
const drills = new DrillPicker();
let drillRequest = null;
let coachSession = null;
let lastDrill = null;
const attacks = new AttackCounter();
let drillPlan = null;
let takeStarted = false;
// Why the current drill take ended: the attacks stopped, the room fell quiet, it ran far too long, or the player
// pressed Space.
let takeEnd = 'space';
let songEditor = null;
let editPhrase = null;
const automaticPause = {practice: false, reading: false, drills: false, library: false, duet: true, learning: true};
let practiceScorePhrase = null;
let lastAttempt = null;
let targetScore = null;
let lastReadingAttempt = null;
let readingProfile = null;
let readingNext = null;
let readingNextPromise = null;
let readingResult = null;
let readingResultBefore = null;
let readingProfilePending = false;
let readingDiscardNext = false;
let readingFinishing = false;
let readingRevision = 0;
let readingTempo = null;
let replayStage = null;
const TEMPO_STEP = 4;
let library = null;
let song = null;
let songPhrase = null;
let previewing = null;
let listening = false;
let playbackScale = 1;
const songStream = new ReadingStream({
  threshold: () => $('threshold').value,
  onChange: () => songReady(),
  onTick: progress => { if (!previewing) sheet.tick(progress); },
  onComplete: progress => finishSong(progress),
  onError: fail,
});
const reading = new ReadingStream({
  threshold: () => $('threshold').value,
  onChange: () => readingReady(),
  onTick: progress => sheet.tick(progress),
  onComplete: progress => finishReading(progress),
  onError: fail,
});

function isPracticeMode(value = mode) {
  return value === 'practice' || value === 'reading' || value === 'drills';
}

function setResumeAt(time) {
  resumeAt = time;
  if (Number.isFinite(time)) resumeAtPerformance = performance.now() + (time - context.currentTime) * 1000;
}

function practiceReady() {
  if (!isPracticeMode() || !practice.task) return;
  renderPractice(practice);
  if (mode === 'reading') { readingReady(); return; }
  if (practice.completed) {
    status('Attempt complete. Your profile is up to date.');
    $('message').textContent = 'Review your feedback below, then choose Next exercise.';
  } else if (!practice.canPlay) {
    status('Listen to the melody first.');
    $('message').textContent = 'Choose Hear melody, then play it back on your piano.';
  } else {
    status(!microphone ? 'Ready when you are.' : mode === 'drills' ? 'Listening. Start when ready; it ends when you stop.' : 'Listening. Take your time.');
    $('message').textContent = microphone
      ? mode === 'drills' ? 'Play the drill. It finishes when you stop, or press space.' : 'Play the exercise, then press Finish attempt or space. There is no time limit.'
      : 'Enable your microphone below, then play the exercise on your piano.';
  }
}

function readingReady() {
  if (mode !== 'reading' || !reading.progress || !practice.task) return;
  const progress = reading.progress;
  renderReadingHud(practice.task, progress, readingProfile?.curriculum, replayStage !== null);
  sheet.progress(practiceScorePhrase, progress, readingNext?.phrase);
  status(microphone || busy ? '' : progress.groups.length ? 'Paused' : '');
}

// The player chooses the tempo, never below a curriculum minimum; grading uses only onsets.
function tempoFor(task) {
  return Math.max(task.reading.minimum_bpm ?? 0, readingTempo ?? task.bpm);
}

function changeTempo(direction) {
  const task = practice.task;
  if (mode !== 'reading' || !task?.reading?.rhythm_required || !reading.progress) return;
  readingTempo = Math.min(TEMPO_LIMITS[1], Math.max(TEMPO_LIMITS[0], task.reading.minimum_bpm ?? 0, tempoFor(task) + direction * TEMPO_STEP));
  void writeLearnerSetting('piano-duet.reading-tempo', String(readingTempo)).catch(fail);
  reading.progress.setTempo(tempoFor(task));
  readingReady();
}

function readingTiming(task) {
  if (!task.reading.rhythm_required) return {};
  const [numerator, denominator] = task.meter.split('/').map(Number);
  return {bpm: task.bpm, end: task.reading.bars * numerator * 4 / denominator * 60 / task.bpm, tempo: tempoFor(task)};
}

async function finishReading(progress) {
  const revision = readingRevision;
  const task = practice.task;
  readingFinishing = true;
  try {
    await stop();
    const result = await localRequest('/api/reading/complete', {
      task: task.id, attempt: crypto.randomUUID(), groups: progress.groups,
      interruptions: [...progress.interruptions], threshold: Number($('threshold').value),
    });
    if (revision !== readingRevision || mode !== 'reading') return;
    lastReadingAttempt = lastAttempt = result.id;
    readingResult = result;
    readingResultBefore = readingProfile;
    readingProfilePending = true;
    readingDiscardNext = false;
    await ensureReadingNext(revision, task);
  } finally {
    if (revision === readingRevision && mode === 'reading' && readingResult) {
      readingReady();
      renderReadingResult($('readingResultTray'), task, readingResult, readingResultBefore,
        readingProfilePending ? null : readingProfile, {
          review: () => openReview(readingResult.id),
          next: () => advanceReading().catch(fail),
          retry: () => retryReading().catch(fail),
        });
    }
    readingFinishing = false;
    buttons();
  }
}

async function refreshReadingResult(revision) {
  if (readingProfilePending) {
    await refreshProfile();
    if (revision !== readingRevision || mode !== 'reading') return;
    readingProfilePending = false;
    readingDiscardNext = readingResultBefore.curriculum.number !== readingProfile.curriculum.number && replayStage === null;
  }
}

async function ensureReadingNext(revision, task) {
  await refreshReadingResult(revision);
  if (revision !== readingRevision || mode !== 'reading') return;
  const waitForNext = () => {
    const pending = readingNextPromise;
    return pending.catch(error => {
      if (readingNextPromise === pending) readingNextPromise = null;
      throw error;
    });
  };
  if (readingDiscardNext) {
    if (readingNextPromise) await waitForNext();
    if (revision !== readingRevision || mode !== 'reading') return;
    if (readingNext) sheet.remove(readingNext.phrase);
    readingNext = null;
    readingNextPromise = null;
    readingDiscardNext = false;
  }
  if (!readingNext && readingNextPromise) await waitForNext();
  if (revision !== readingRevision || mode !== 'reading') return;
  if (!readingNext) {
    readingNextPromise = prepareReadingNext(revision, task);
    await waitForNext();
  }
}

async function advanceReading() {
  if (!readingResult) throw new Error('There is no completed score to advance from.');
  const revision = readingRevision;
  await ensureReadingNext(revision, practice.task);
  if (revision !== readingRevision || mode !== 'reading') return;
  if (!readingNext) throw new Error('The next reading score is not ready.');
  const next = readingNext;
  readingResult = null;
  $('readingResultTray').hidden = true;
  sheet.remove(practiceScorePhrase);
  practice.acceptTask(next.task);
  practiceScorePhrase = next.phrase;
  readingNext = null;
  reading.advance(next.task.target, readingTiming(next.task));
  for (const details of $('exerciseDialog').querySelectorAll('details')) details.open = false;
  showKey(next.task.key);
  readingNextPromise = prepareReadingNext(readingRevision, next.task);
  readingNextPromise.catch(fail);
  practiceReady();
  buttons();
}

async function retryReading() {
  if (!readingResult) throw new Error('There is no completed score to retry.');
  const revision = readingRevision;
  await refreshReadingResult(revision);
  if (revision !== readingRevision || mode !== 'reading') return;
  const task = await localRequest(`/api/reading/${practice.task.id}/retry`, {});
  if (revision !== readingRevision || mode !== 'reading') return;
  ++readingRevision;
  if (readingNext) sheet.remove(readingNext.phrase);
  readingNext = null;
  readingResult = null;
  $('readingResultTray').hidden = true;
  sheet.clear();
  practice.acceptTask(task);
  practiceScorePhrase = addReadingPhrase(task);
  reading.reset(task.target, readingTiming(task));
  for (const details of $('exerciseDialog').querySelectorAll('details')) details.open = false;
  readingNextPromise = prepareReadingNext(readingRevision, task);
  readingNextPromise.catch(fail);
  showKey(task.key);
  practiceReady();
  buttons();
}

function addReadingPhrase(task) {
  return sheet.add('target', task.target, {bpm: task.bpm || 60, key: task.key, title: task.title, id: task.id,
    clef: task.reading.clef, meter: task.meter, bars: task.reading.bars, exact: true});
}

export async function loadLibrary() {
  library = await localRequest('/api/library');
  showLibrary();
}

function showLibrary() {
  renderLibrary(library, $('librarySearch').value, {
    onOpen: id => openSong(id).catch(fail),
    onDelete: item => deleteSong(item).catch(fail),
  });
}

async function importSong(file) {
  const params = new URLSearchParams({filename: file.name});
  const response = await localFetch(`/api/library/import?${params}`, {
    method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'X-Duet-Client': '1'}, body: await file.arrayBuffer(),
  });
  if (!response.ok) throw new Error((await response.json()).detail);
  await loadLibrary();
}

function youtubeProgress(label, value) {
  $('youtubeProgress').hidden = false;
  $('youtubeStage').textContent = label;
  $('youtubeFill').style.width = `${Math.round(100 * value)}%`;
}

function youtubeError(message) {
  $('youtubeError').textContent = message;
  $('youtubeError').hidden = false;
  $('youtubeProgress').hidden = true;
  $('youtubeGo').disabled = false;
}

async function importYoutube(event) {
  event.preventDefault();
  $('youtubeError').hidden = true;
  $('youtubeGo').disabled = true;
  youtubeProgress('Downloading', 0);
  const response = await localFetch('/api/library/youtube', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Duet-Client': '1'},
    body: JSON.stringify({url: $('youtubeUrl').value, has_rights: $('youtubeRights').checked})});
  if (!response.ok) { youtubeError((await response.json()).detail); return; }
  for await (const update of readEvents(response.body)) {
    if (update.type === 'downloading') youtubeProgress('Downloading', 0.3 * update.progress);
    if (update.type === 'transcribing') youtubeProgress('Finding the notes', 0.3 + 0.6 * update.progress);
    if (update.type === 'arranging') youtubeProgress(`Writing ${update.notes} notes into a score`, 0.95);
    if (update.type === 'error') { youtubeError(update.message); return; }
    if (update.type === 'song') {
      youtubeProgress('Done', 1);
      $('youtubeGo').disabled = false;
      $('youtubeUrl').value = '';
      $('youtubeDialog').close();
      await loadLibrary();
      await openSong(update.song.id);
    }
  }
}

async function deleteSong(item) {
  if (!confirm(`Remove “${item.title}” and its play history?`)) return;
  const response = await localFetch(`/api/library/${item.id}`, {method: 'DELETE', headers: {'X-Duet-Client': '1'}});
  if (!response.ok) throw new Error((await response.json()).detail);
  await loadLibrary();
}

async function openSong(id) {
  const loaded = await localRequest(`/api/library/${id}`);
  if (mode !== 'library') return;
  showSong(loaded);
}

function showSong(loaded) {
  song = loaded;
  sheet.use('library', SCORE_VIEWS.library);
  songPhrase = sheet.add('target', song.notes, {bpm: song.bpm, key: song.key, title: song.title, id: song.id, clef: 'grand',
    meter: song.meter, bars: song.bars, exact: true, final: true});
  songStream.reset(song.notes, {locate: true});
  document.body.classList.add('song-open');
  songReady();
  buttons();
}

async function closeSong() {
  if (!song) return;
  if (songEditor) closeEditor();
  await saveSongPlay();
  songStream.pause();
  song = null;
  songPhrase = null;
  document.body.classList.remove('song-open');
  sheet.clear();
  buttons();
  await loadLibrary();
}

async function openEditor() {
  if (!song || songEditor) return;
  if (microphone || previewing) await stop();
  songStream.pause();
  songEditor = new SongEditor(song);
  document.body.classList.add('song-editing');
  $('songEditBar').hidden = false;
  $('editMore').setAttribute('aria-expanded', 'false');
  sheet.use('editor', SCORE_VIEWS.editor);
  editPhrase = sheet.add('target', songEditor.draft.notes, {bpm: songEditor.draft.bpm, key: songEditor.key, title: song.title,
    exact: true, meter: songEditor.draft.meter});
  refreshEditor();
  buttons();
}

// The score shows the draft; the page keeps its scroll position while it re-renders.
function refreshEditor() {
  const {draft} = songEditor;
  // The redrawn score rings the editor's current selection, which an edit may have moved.
  sheet.update(editPhrase, {notes: draft.notes.map(note => ({...note})), bpm: draft.bpm, key: songEditor.key, meter: draft.meter,
    selected: songEditor.selected === null ? [] : [songEditor.selected]});
  $('editTempo').value = draft.bpm;
  $('editMeter').replaceChildren(...METERS.map(meter => new Option(meter, meter)));
  $('editMeter').value = draft.meter;
  $('editKey').replaceChildren(...['major', 'minor'].flatMap(keyMode => [...Array(12).keys()].map(tonic =>
    new Option(musicalKey(tonic, keyMode).name, `${tonic}:${keyMode}`))));
  $('editKey').value = `${draft.tonic}:${draft.mode}`;
  $('editUndo').disabled = !songEditor.dirty;
  $('editRevert').disabled = !song.original;
}

function editAction(action) {
  if (!songEditor) return;
  const before = songEditor.draft;
  action();
  // Moving the selection only moves the ring; changing the music re-renders the score.
  if (songEditor.draft === before) sheet.highlight(editPhrase, songEditor.selected === null ? [] : [songEditor.selected]);
  else refreshEditor();
}

function closeEditor() {
  songEditor = null;
  editPhrase = null;
  document.body.classList.remove('song-editing');
  $('songEditBar').hidden = true;
}

async function saveEdits() {
  const saved = await localRequest(`/api/library/${song.id}`, songEditor.request(), 'PUT');
  closeEditor();
  showSong(saved);
}

async function revertEdits() {
  if (!window.confirm('Revert this song to its original transcription? Your edits will be lost.')) return;
  const reverted = await localRequest(`/api/library/${song.id}/revert`, {});
  closeEditor();
  showSong(reverted);
  await openEditor();
}

function cancelEdits() {
  if (songEditor.dirty && !window.confirm('Discard your changes to this song?')) return;
  closeEditor();
  showSong(song);
}

function editClick(event, add) {
  const hit = songEditor && sheet.hit(event);
  if (!hit || hit.phrase !== editPhrase) return;
  const id = sheet.noteAt(hit);
  if (id !== null) { songEditor.selected = id; sheet.highlight(editPhrase, [id]); return; }
  if (!add) { songEditor.selected = null; sheet.highlight(editPhrase, []); return; }
  const place = sheet.placeAt(hit);
  if (place) editAction(() => songEditor.add(place));
}

function jumpSong(ordinal) {
  songStream.progress.jump(ordinal);
  songReady();
}

function songReady() {
  if (mode !== 'library' || !song) return;
  const progress = previewing?.view || songStream.progress;
  renderSongHud(song, song.stats, progress, ordinal => { if (!previewing) jumpSong(ordinal); });
  sheet.progress(songPhrase, progress, null);
  status(previewing ? 'Preview' : microphone || busy ? '' : songStream.progress.results.size ? 'Paused' : '');
}

async function saveSongPlay() {
  const progress = songStream.progress;
  if (!song || !progress?.results.size) return;
  const attacks = [...progress.results];
  progress.results = new Map();
  song.stats = await localRequest(`/api/library/${song.id}/plays`, {id: crypto.randomUUID(), attacks});
  songReady();
}

async function finishSong(progress) {
  const accuracy = sessionAccuracy(progress);
  await saveSongPlay();
  showBanner({kind: 'stage', caption: 'Song complete', title: accuracy === null ? song.title : `${accuracy}%`, detail: `${song.title} · first try`});
  songStream.reset(song.notes, {locate: true});
  songReady();
}

async function previewSong() {
  if (!song || busy) return;
  if (microphone) await stop();
  await context.resume();
  const progress = songStream.progress;
  const from = Math.min(currentOrdinal(progress), progress.attacks.length - 1);
  const origin = song.notes[progress.attacks[from].indices[0]].start;
  busy = true;
  playbackStart = context.currentTime + 0.3;
  playbackEnd = playbackStart;
  for (const note of song.notes.filter(note => note.start >= origin - 1e-6)) {
    piano.play(note, playbackStart + note.start - origin);
    playbackEnd = Math.max(playbackEnd, playbackStart + note.start - origin + note.duration);
  }
  setResumeAt(playbackEnd + 0.4);
  previewing = {origin, ordinal: -1, view: null};
  buttons();
}

function previewTick() {
  const progress = songStream.progress;
  const time = context.currentTime - playbackStart + previewing.origin;
  let ordinal = progress.attacks.findIndex(attack => song.notes[attack.indices[0]].start > time + 1e-6) - 1;
  if (ordinal === -2) ordinal = progress.attacks.length - 1;
  ordinal = Math.max(0, ordinal);
  if (ordinal === previewing.ordinal) return;
  previewing.ordinal = ordinal;
  const index = progress.attacks[ordinal].indices[0];
  previewing.view = {target: progress.target, attacks: progress.attacks, index, displayIndex: index, wrong: [], mistakes: new Set(),
    timing: null, bpm: null, streak: progress.streak, results: progress.results, preview: true};
  songReady();
}

function openReview(id) {
  reading.interrupt();
  const reviewOnly = !ENABLED_MODES.includes('practice');
  $('profileDialog').classList.toggle('review-only', reviewOnly);
  $('profileTitle').textContent = reviewOnly ? 'Your score' : 'Your progress';
  $('profileDialog').showModal();
  inspectAttempt(id).catch(fail);
}

function replayRequest() {
  return replayStage === null ? {} : {stage: replayStage};
}

function chooseStage(number) {
  replayStage = number;
  if (number === null) localStorage.removeItem('piano-duet.reading-stage');
  else localStorage.setItem('piano-duet.reading-stage', number);
  $('readingProgressDialog').close();
  loadPractice().catch(fail);
}

function renderReadingCareer() {
  renderCareer(readingProfile, id => { $('readingProgressDialog').close(); openReview(id); }, replayStage, chooseStage);
}

function openCareer() {
  renderReadingCareer();
  $('readingProgressDialog').showModal();
  $('readingProgressDialog').scrollTop = 0;
}

async function prepareReadingNext(revision, after, saving) {
  await saving;
  if (revision !== readingRevision || mode !== 'reading') return null;
  const task = await localRequest('/api/practice/next', {focus: 'reading', step_by_step: true, after: after.id, ...replayRequest()});
  if (revision !== readingRevision || mode !== 'reading') return null;
  readingNext = {task, phrase: addReadingPhrase(task)};
  readingReady();
  return readingNext;
}

function showPracticeTarget() {
  if (practiceScorePhrase) return;
  const task = practice.task;
  const staves = new Set(task.target.map(note => note.staff));
  // A one-hand drill that stays on one staff needs no empty second staff.
  practiceScorePhrase = mode === 'reading' ? addReadingPhrase(task)
    : sheet.add('target', task.target, {bpm: task.bpm || 60, key: task.key, title: task.title, meter: task.meter,
      exact: Boolean(task.drill), clef: task.drill && staves.size === 1 ? [...staves][0] : null});
  $('emptyRoll').hidden = true;
}

export async function refreshProfile() {
  const profile = await localRequest('/api/profile');
  readingProfile = profile.reading;
  renderLevel(readingProfile.xp);
  // Excluding evidence can relock a stage, and replaying the frontier is ordinary play.
  if (replayStage !== null && (readingProfile.curriculum.path[replayStage - 1].status === 'Ahead' || replayStage === readingProfile.curriculum.number)) {
    replayStage = null;
    localStorage.removeItem('piano-duet.reading-stage');
  }
  if ($('readingProgressDialog').open) renderReadingCareer();
  renderProfile(profile, id => inspectAttempt(id).catch(fail));
  if (profile.recent.length) lastAttempt = profile.recent.find(attempt => attempt.note_count > 0 && attempt.context.interaction !== 'step_by_step')?.id || null;
  $('savePieceForm').hidden = !lastAttempt;
}

export async function refreshSyncedData() {
  await initialized;
  await refreshLearnerSettings();
  await applyLearnerSettings();
  await Promise.all([refreshProfile(), loadPieces(), drills.refresh(), loadLibrary()]);
  if ($('drillLogDialog').open) {
    drills.renderLevels(drill => { $('drillLogDialog').close(); loadDrill({focus: drill}); });
    drills.renderLog(config => { $('drillLogDialog').close(); drills.adopt(config); loadDrill(config); });
  }
}

async function inspectAttempt(id) {
  renderAttempt(await localRequest(`/api/attempts/${id}`), (id, excluded) => excludeAttempt(id, excluded).catch(fail));
  if (!$('profileDialog').open) return;
  $('attemptDetail').scrollIntoView({block: 'start'});
  $('attemptDetail').focus({preventScroll: true});
}

async function excludeAttempt(id, excluded) {
  await localRequest(`/api/attempts/${id}/exclude`, {excluded});
  if (practice.attemptId === id) { practice.excluded = excluded; renderPractice(practice); }
  await Promise.all([refreshProfile(), inspectAttempt(id)]);
}

async function loadPractice() {
  const generation = epoch;
  const revision = ++readingRevision;
  readingNext = null;
  readingNextPromise = null;
  readingResult = null;
  $('readingResultTray').hidden = true;
  reading.pause();
  busy = true;
  detector.reset();
  buttons();
  status(mode === 'reading' ? 'Preparing a fresh score…' : mode === 'drills' ? 'Setting up your drill…' : 'Choosing your next step…');
  let task;
  let adopt = false;
  if (mode === 'drills') {
    if (!drills.catalog) await drills.refresh();
    let request = drillRequest;
    drillRequest = null;
    if (!request) {
      const saved = drills.saved();
      if (saved) { drills.sync(saved); request = drills.next(); }
      else request = {};
    }
    adopt = !request.drill;
    task = await localRequest('/api/drills/next', request);
    lastDrill = {...configOf(task), ...(request.rung === undefined ? {} : {rung: request.rung})};
  } else {
    const focus = mode === 'reading' ? 'reading' : $('practiceFocus').value;
    task = await localRequest('/api/practice/next', {focus, step_by_step: mode === 'reading', ...(mode === 'reading' ? replayRequest() : {}),
      ...($('practicePiece').value && focus === 'repertoire' ? {piece: $('practicePiece').value} : {})});
  }
  if (task.family === 'repertoire') await loadPieces();
  if (generation !== epoch || revision !== readingRevision || !isPracticeMode()) return;
  practice.acceptTask(task);
  if (mode === 'drills') {
    if (adopt) drills.adopt(task.drill);
    drills.show(task);
    drillPlan = attackPlan(task);
    attacks.reset();
    if (coachSession && !coachSession.config) {
      coachSession.used.push(task.drill.drill);
      showBanner({kind: 'stage', caption: `Block ${coachSession.index + 1} of ${coachSession.plan.blocks}`, title: drills.levels[task.drill.drill].name, detail: task.drill.coach});
    }
    // Whatever loads during a session, coach pick or the player's own change, is what the block repeats.
    if (coachSession) coachSession.config = lastDrill;
  }
  if (mode === 'reading') reading.reset(task.target, readingTiming(task));
  for (const details of $('exerciseDialog').querySelectorAll('details')) details.open = false;
  heard = []; reply = []; transcript = [];
  sheet.clear();
  practiceScorePhrase = null;
  $('scoreError').hidden = true;
  if (practice.visible) showPracticeTarget();
  else sheet.message(task.family === 'ear' ? 'Let your ears lead. Hear the melody, then find it on the keys.' : 'Find the notes yourself. Reveal the score whenever you need help.');
  showKey(task.key);
  $('turnCount').textContent = `${task.family.toUpperCase()} · STAGE ${task.challenge}`;
  $('emptyRoll').hidden = practice.visible;
  if (task.family === 'reading' || task.drill) {
    $('sheetPanel').hidden = false; $('rollPanel').hidden = true;
    $('sheetView').setAttribute('aria-pressed', true); $('rollView').setAttribute('aria-pressed', false);
  }
  if (mode === 'reading') {
    readingNextPromise = prepareReadingNext(revision, task);
    await readingNextPromise;
    if (generation !== epoch || revision !== readingRevision || mode !== 'reading') return;
  }
  $('timing').textContent = 'Your exercise';
  // An example still playing keeps its state; the draw loop ends it when the sound does.
  busy = listening;
  if (listening) sheet.playing = practiceScorePhrase;
  practiceReady();
  buttons();
}

async function practiceAid(kind) {
  if (!practice.task || busy) return;
  const generation = epoch;
  busy = true;
  reading.pause();
  detector.reset();
  buttons();
  if (!practice.completed) practice.task = await localRequest(`/api/practice/${practice.task.id}/aid`, {kind});
  if (generation !== epoch) return;
  renderPractice(practice);
  if (kind === 'hints') {
    busy = false;
    practiceReady(); buttons();
    return;
  }
  if (kind === 'reveals') {
    showPracticeTarget();
    $('sheetPanel').hidden = false; $('rollPanel').hidden = true;
    $('sheetView').setAttribute('aria-pressed', true); $('rollView').setAttribute('aria-pressed', false);
    busy = false;
    practiceReady(); buttons();
    return;
  }
  await context.resume();
  if (generation !== epoch) return;
  playbackStart = context.currentTime + 0.2;
  playbackEnd = playbackStart;
  sheet.playing = practiceScorePhrase;
  // Reading plays back at the tempo the player chose, not the score's suggested one.
  playbackScale = mode === 'reading' && reading.progress?.bpm ? practice.task.bpm / reading.progress.tempo : 1;
  for (const note of practice.task.target) {
    const scaled = {...note, start: note.start * playbackScale, duration: note.duration * playbackScale};
    piano.play(scaled, playbackStart + scaled.start);
    playbackEnd = Math.max(playbackEnd, playbackStart + scaled.start + scaled.duration + 0.2);
  }
  setResumeAt(playbackEnd + 0.75);
  listening = true;
  status(mode === 'reading' ? 'Listen to the score.' : 'Listen to the example.', '#95c8d2');
  $('message').textContent = 'The microphone waits while the piano plays.';
  buttons();
}

// Stopping playback keeps the microphone on, unlike the transport Stop.
function toggleListening() {
  if (!listening) { practiceAid('hearings').catch(fail); return; }
  piano.stop();
  setResumeAt(context.currentTime);
}

function loadDrill(request) {
  drillRequest = request;
  loadPractice().catch(fail);
}

function showDrillOptions(open) {
  $('drillOptions').hidden = !open;
  $('drillToggle').setAttribute('aria-expanded', open);
}

const CONFIG_FIELDS = ['drill', 'variant', 'tonic', 'hands', 'octaves', 'inversion', 'practice'];
function configOf(task) {
  return Object.fromEntries(CONFIG_FIELDS.map(field => [field, task.drill[field]]));
}

function changeDrillTempo(direction) {
  const drill = practice.task?.drill;
  if (mode !== 'drills' || busy || detector.active || !drill) return;
  const rung = drill.rung + direction;
  if (rung < 0 || rung >= drill.rungs) return;
  loadDrill({...lastDrill, rung});
}

// Each take ends in stats; the next take is ready at once: the same drill (Build or a session block)
// or a fresh roll of any Random choice (Mix).
async function showDrillResult(assessment) {
  const task = practice.task;
  const attempt = practice.attemptId;
  if (!assessment.drill) return;
  const previous = drills.entry(task);
  const before = {best: previous?.best_tempo ?? null, level: drills.levels[task.drill.drill].level};
  await drills.refresh();
  if (mode !== 'drills' || practice.task !== task) return;
  const entry = drills.entry(task);
  const level = drills.levels[task.drill.drill];
  const rate = item => (item ? item.per_beat * item.bpm : 0);
  const best = entry?.best_tempo ?? null;
  const line = task.drill.practice !== 'even' ? null
    : rate(best) > rate(before.best) ? `New steady tempo: ${tempoLabel(best.per_beat, best.bpm)}`
      : streakText(entry, task.drill.streak_needed);
  drills.renderResults(task, assessment, () => openReview(attempt), line);
  if (level.level > before.level) {
    showBanner({kind: 'level', caption: 'Level up', title: `${level.name} · level ${level.level}`,
      detail: level.next ? `Next: ${level.next.keys} keys at ${tempoLabel(level.next.tempo.per_beat, level.next.tempo.bpm)}` : 'Top level'});
  }
  $('drillLast').textContent = `Last ${assessment.score.score}`;
  $('drillLast').hidden = false;
  if (coachSession) {
    coachSession.takes++;
    coachSession.blockTakes++;
    if (sessionLeft() <= 0) {
      if (coachSession.index + 1 < coachSession.plan.blocks) { coachSession.index++; startBlock(); }
      else endSession();
      return;
    }
    loadDrill(coachSession.config);
    return;
  }
  loadDrill($('drillFlow').value === 'mix' ? drills.next() : lastDrill);
}

function sessionLeft() {
  return coachSession.plan.kind === 'minutes' ? coachSession.plan.per * 60000 - (Date.now() - coachSession.blockStart) : coachSession.plan.per - coachSession.blockTakes;
}

function sessionLabel() {
  if (!coachSession) return 'Session';
  const left = Math.max(0, sessionLeft());
  const remaining = coachSession.plan.kind === 'minutes'
    ? `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`
    : `${Math.ceil(left)} left`;
  return `${coachSession.index + 1}/${coachSession.plan.blocks} · ${remaining}`;
}

async function startSession(kind, amount) {
  await drills.refresh();
  coachSession = {plan: planSession(kind, amount), index: 0, takes: 0, used: [], startedAt: Date.now(),
    before: {levels: structuredClone(drills.levels), progress: structuredClone(drills.progress)}};
  $('sessionDialog').close();
  showDrillOptions(false);
  startBlock();
}

function startBlock() {
  coachSession.blockStart = Date.now();
  coachSession.blockTakes = 0;
  coachSession.config = null;
  loadDrill({avoid: coachSession.used});
}

function endSession() {
  const {before, takes, startedAt} = coachSession;
  const lines = [];
  for (const [drill, level] of Object.entries(drills.levels)) {
    if (level.level !== before.levels[drill].level) lines.push(`${level.name}: level ${before.levels[drill].level} → ${level.level}`);
  }
  for (const [key, entry] of Object.entries(drills.progress)) {
    if (entry.last * 1000 < startedAt) continue;
    const old = before.progress[key];
    const from = old ? old.working_tempo : drills.catalog.drills[entry.config.drill].ladder[drills.catalog.drills[entry.config.drill].start];
    const to = entry.working_tempo;
    lines.push(`${entry.title}: ${from.bpm === to.bpm && from.per_beat === to.per_beat ? `held ${tempoLabel(to.per_beat, to.bpm)}` : `${tempoLabel(from.per_beat, from.bpm)} → ${tempoLabel(to.per_beat, to.bpm)}`}`);
  }
  const minutes = Math.round((Date.now() - startedAt) / 60000);
  coachSession = null;
  drills.renderSummary(`Session complete · ${minutes} min · ${takes} take${takes === 1 ? '' : 's'}`, lines, () => $('sessionDialog').showModal());
  showBanner({kind: 'stage', caption: 'Session complete', title: `${takes} takes`, detail: lines[0]});
  buttons();
}

function openSessionDialog() {
  $('sessionChoices').hidden = Boolean(coachSession);
  $('sessionActive').hidden = !coachSession;
  if (coachSession) $('sessionState').textContent = `Block ${coachSession.index + 1} of ${coachSession.plan.blocks} · ${sessionLabel()} · ${coachSession.takes} take${coachSession.takes === 1 ? '' : 's'} so far.`;
  $('sessionDialog').showModal();
}

// A take ends once the attacks stop (see takeEnded), once the room has been quiet for a while, or long after
// the drill should have finished.
const DRILL_QUIET = 1.5;
function drillFinished() {
  if (!detector.active) return false;
  const last = Math.max(...practice.task.target.map(note => note.start)) + 60 / practice.task.bpm;
  const heardTimes = heardAttacks(attacks.times, attacks.strengths);
  const sinceLast = attacks.seconds - (heardTimes.at(-1) ?? 0);
  if (takeEnded(drillPlan, heardTimes.length, sinceLast, playedGap(drillPlan, heardTimes))) { takeEnd = 'attacks'; return true; }
  // A backstop if the counter misses notes: the room has been quiet for a while after some playing.
  if (heardTimes.length && detector.quiet >= DRILL_QUIET) { takeEnd = 'quiet'; return true; }
  if (detector.samples / 16000 >= 2 * last + 5) { takeEnd = 'limit'; return true; }
  return false;
}

// What the live attack counter heard during a take, saved with it so a take that ends late can be explained.
function takeListening() {
  const round = value => Math.round(value * 10000) / 10000;
  return {ended: takeEnd, floor: round(Math.max(10 ** (detector.gate / 20), detector.noise * 3)), noise: round(detector.noise),
    attacks: attacks.times.map(round), strengths: attacks.strengths.map(round), seconds: round(attacks.seconds)};
}

// Room sound that keeps the detector open without a single piano attack is not a take.
function drillIdle() {
  return detector.active && attacks.count === 0 && detector.samples / 16000 > 6;
}

async function openLevels() {
  await drills.refresh();
  drills.renderLevels(drill => { $('drillLogDialog').close(); loadDrill({focus: drill}); });
  drills.renderLog(config => { $('drillLogDialog').close(); drills.adopt(config); loadDrill(config); });
  $('drillLogDialog').showModal();
}

async function loadPieces() {
  const pieces = await localRequest('/api/pieces');
  const selected = $('practicePiece').value;
  $('practicePiece').replaceChildren(new Option('Most recently saved', ''));
  for (const piece of pieces) $('practicePiece').add(new Option(piece.title, piece.id));
  $('practicePiece').value = selected;
}

async function hearBeat() {
  if (busy || !practice.task?.bpm) return;
  reading.pause();
  const generation = epoch;
  busy = true; setResumeAt(Infinity); buttons();
  await context.resume();
  if (generation !== epoch) return;
  const bpm = mode === 'reading' && reading.progress?.bpm ? reading.progress.tempo : practice.task.bpm;
  const beat = 60 / bpm;
  const start = context.currentTime + 0.1;
  const groups = beatGroups(practice.task.meter);
  let offset = 0;
  for (const [i, length] of groups.entries()) {
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = i === 0 ? 1000 : 700;
    gain.gain.setValueAtTime(0.09, start + offset * beat);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset * beat + 0.06);
    tone.connect(gain).connect(piano.gain);
    tone.start(start + offset * beat); tone.stop(start + offset * beat + 0.07);
    piano.sound(start + offset * beat + 0.07);
    piano.sources.add(tone);
    tone.onended = () => { piano.sources.delete(tone); tone.disconnect(); gain.disconnect(); };
    offset += length;
  }
  setResumeAt(start + offset * beat + 0.3);
  status(`${practice.task.meter} · ♩ = ${bpm}`);
}

async function savePiece(event) {
  event.preventDefault();
  if (!lastAttempt) throw new Error('Play something before saving a piece.');
  const piece = await localRequest('/api/pieces', {attempt: lastAttempt, title: $('pieceTitle').value});
  $('pieceSaved').textContent = `Saved “${piece.title}”. Choose Repertoire in the Practice focus menu to learn it.`;
  $('pieceTitle').value = '';
  await loadPieces();
}

function learningStep(step, instruction) {
  for (const name of ['idea', 'listen', 'repeat', 'score']) {
    if (name === step) $(`${name}Step`).setAttribute('aria-current', 'step');
    else $(`${name}Step`).removeAttribute('aria-current');
  }
  $('learningInstruction').textContent = instruction;
}

function learningReady() {
  if (mode !== 'learning') return;
  if (learning.stage === 'repeat') {
    learningStep('repeat', 'Your turn: play back the practice target. Take your time; a consistent slower tempo is fine.');
    status(microphone ? 'Your turn. Play back the target.' : 'Enable your microphone to play back the target.');
    $('message').textContent = 'Play the practice target, then pause or press Answer now for your score.';
  } else if (learning.result) {
    learningStep('score', 'Round complete. Play a new idea whenever you are ready to start again.');
    status('Round complete. Ready for your next idea.');
    $('message').textContent = 'Your next phrase starts a new learning round.';
  } else {
    learningStep('idea', 'Play an idea you like. Aria will suggest a version to practice.');
    $('message').textContent = 'Play your own idea, then pause or press Answer now to hear the practice target.';
  }
}

function clearLearning() {
  learning.reset();
  targetScore = null;
  $('learningResult').hidden = true;
  $('surpriseDetails').hidden = true;
  $('surpriseRows').replaceChildren();
  learningReady();
}

async function selectMode(value, persist = true) {
  if (!ENABLED_MODES.includes(value)) throw new Error(`Playing mode ${value} is disabled.`);
  if (value === mode) return;
  if (mode === 'library') await closeSong();
  reading.pause();
  mode = value;
  if (persist) await writeLearnerSetting('piano-duet.mode', mode);
  updateModeControls();
  reset();
  if (isPracticeMode()) await loadPractice();
  if (mode === 'library') await loadLibrary();
}

function updateModeControls() {
  const value = mode;
  document.body.dataset.mode = value;
  if (value !== 'reading') { readingResult = null; $('readingResultTray').hidden = true; $('noteStatus').textContent = ''; }
  $('currentMode').textContent = $(`${value}Mode`).textContent;
  $('openProfile').hidden = value === 'library' && !ENABLED_MODES.includes('practice');
  for (const selector of ['.session-info', '.session-actions', '.key-settings', '.score-settings']) {
    document.querySelector(selector).hidden = !['practice', 'duet', 'learning'].includes(value);
  }
  $('modeMenuButton').setAttribute('aria-expanded', 'false');
  $('drillMore').setAttribute('aria-expanded', 'false');
  const practicing = isPracticeMode();
  $('practiceMode').setAttribute('aria-pressed', value === 'practice');
  $('readingMode').setAttribute('aria-pressed', value === 'reading');
  $('drillsMode').setAttribute('aria-pressed', value === 'drills');
  $('drillPanel').hidden = value !== 'drills';
  $('duetMode').setAttribute('aria-pressed', value === 'duet');
  $('learningMode').setAttribute('aria-pressed', value === 'learning');
  $('learningPanel').hidden = value !== 'learning';
  $('learningSettings').hidden = value !== 'learning';
  $('duetSettings').hidden = value !== 'duet';
  $('practicePanel').hidden = !practicing;
  $('practiceSettings').hidden = value !== 'practice';
  $('musicDisplay').hidden = value === 'reading';
  $('fingerHelp').hidden = value !== 'reading';
  $('readingHud').hidden = value !== 'reading';
  $('libraryPanel').hidden = value !== 'library';
  $('songHud').hidden = value !== 'library';
  $('libraryMode').setAttribute('aria-pressed', value === 'library');
  $('sheetMusic').setAttribute('aria-label', value === 'reading' ? 'Reading music' : 'Sheet music');
  $('practiceChallenge').classList.toggle('reading-caption', value === 'reading');
  $('readingHelpActions').hidden = value !== 'reading';
  $('autoReplyControls').hidden = !['practice', 'duet', 'learning'].includes(value);
  $('practiceFinishHelp').textContent = value === 'reading'
    ? 'Play the highlighted note. The score advances automatically when you find the right key.'
    : 'Take your time, then press Finish attempt or space.';
  $('hearPractice').textContent = value === 'reading' ? 'Hear this score' : 'Hear example';
  if (value === 'reading') $('readingHelpActions').prepend($('hearPractice'));
  else $('practiceActions').prepend($('hearPractice'));
  $('nextPractice').textContent = value === 'reading' ? 'Next score →' : value === 'drills' ? 'Again →' : 'Next exercise →';
  $('keyCaption').textContent = practicing ? 'KEY OF THIS EXERCISE' : 'KEY OF YOUR LATEST PHRASE';
  $('notationHelp').textContent = practicing
    ? 'Exercise notation follows the task. Tempo and meter controls apply to your transcribed performance.'
    : 'Approximate written rhythms. Tempo and meter change the score; playback keeps your timing.';
  $('demo').hidden = practicing;
  $('answer').innerHTML = practicing ? 'Finish attempt <kbd>space</kbd>' : 'Answer now <kbd>space</kbd>';
  $('autoReply').checked = automaticPause[value];
  $('pause').disabled = !$('autoReply').checked;
  $('partnerLabel').textContent = value === 'reading' ? 'Score' : practicing ? 'Exercise' : value === 'learning' ? 'Practice target' : 'Duet';
  $('modeDescription').textContent = value === 'practice' ? 'Personal practice, shaped by what you play.' : value === 'learning'
    ? 'Play an idea, hear a variation, then play it back for a score.'
    : 'Trade musical ideas with your AI piano partner.';
  $('modeDescription').hidden = value !== 'duet';
}

function status(text, color = '#9ab89d') {
  $('status').textContent = text;
  $('statusDot').style.background = color;
}

function buttons() {
  appearance.setLocked(Boolean(microphone));
  document.body.classList.toggle('is-playing', Boolean(microphone));
  $('songEdit').disabled = busy || Boolean(songEditor);
  $('start').disabled = readingFinishing || Boolean(readingResult) || !ready || (!microphone && busy && !previewing) || (mode === 'library' && !song);
  $('start').setAttribute('aria-pressed', Boolean(microphone));
  $('micState').textContent = microphone ? 'Mic on' : 'Mic ready';
  $('drillProgress').hidden = mode !== 'drills';
  $('drillBest').hidden = mode !== 'drills';
  const following = mode === 'reading' || mode === 'library';
  $('start').classList.toggle('no-key', Boolean(microphone) && !following);
  $('micLabel').textContent = previewing ? 'Stop preview' : microphone ? (following ? 'Stop' : 'Mic off')
    : mode === 'reading' && reading.progress?.groups.length ? 'Resume'
      : mode === 'library' && songStream.progress?.groups.length ? 'Resume' : 'Start';
  $('answer').disabled = !microphone || busy || calibrating > 0 || !detector.active;
  $('answer').hidden = mode === 'reading' || mode === 'library' || (mode === 'drills' && !detector.active) || !microphone || busy || (isPracticeMode() && (!practice.canPlay || practice.completed));
  $('nextPractice').hidden = mode === 'reading' || mode === 'library' || mode === 'drills' || !isPracticeMode() || !practice.completed || busy;
  $('stop').disabled = !microphone && !busy;
  $('stop').hidden = !busy || mode === 'library';
  $('demo').disabled = !ready || busy || Boolean(microphone) || (mode === 'learning' && learning.stage === 'repeat');
  $('demo').hidden = isPracticeMode() || Boolean(microphone) || (mode === 'learning' && learning.stage === 'repeat');
  $('reset').disabled = busy || transcript.length === 0;
  $('reset').hidden = isPracticeMode() || transcript.length === 0;
  $('export').disabled = busy || transcript.length === 0;
  $('export').hidden = transcript.length === 0;
  $('microphone').disabled = Boolean(microphone) || busy;
  for (const id of ['duetMode', 'learningMode', 'newRound']) $(id).disabled = busy || detector.active;
  for (const id of ['practiceMode', 'readingMode', 'practiceFocus', 'practicePiece', 'nextPractice', 'skipPractice']) $(id).disabled = !ready || busy || detector.active;
  for (const id of ['drillNext', 'drillAuto', 'drillSession']) $(id).disabled = !ready || busy || detector.active;
  $('drillSession').classList.toggle('active', Boolean(coachSession));
  for (const id of ['revealPractice', 'practiceBeat', 'hudBeat', 'drillBeat']) $(id).disabled = readingFinishing || !ready || busy || detector.active || !practice.task;
  for (const id of ['hearPractice', 'hudListen', 'drillListen']) $(id).disabled = readingFinishing || !ready || (busy && !listening) || detector.active || !practice.task;
  if (listening) $('hearPractice').textContent = 'Stop playback';
  $('hudListen').textContent = listening ? 'Stop' : 'Listen';
  $('hudListen').classList.toggle('playing', listening);
  $('hudListen').setAttribute('aria-label', listening ? 'Stop playback' : 'Hear this score (halves its XP)');
  $('hudListen').title = $('hudListen').getAttribute('aria-label');
  $('drillListen').textContent = listening ? 'Stop' : 'Listen';
  $('drillListen').classList.toggle('playing', listening);
  $('drillListen').setAttribute('aria-label', listening ? 'Stop playback' : 'Hear it played');
  $('drillListen').title = $('drillListen').getAttribute('aria-label');
  $('practiceHelp').inert = busy || detector.active;
  $('openAnalysis').hidden = mode !== 'learning' || $('surpriseDetails').hidden;
  $('hearPractice').classList.toggle('primary', !practice.canPlay && !practice.completed);
  $('hearPractice').classList.toggle('secondary', practice.canPlay || practice.completed);
  $('rollView').disabled = isPracticeMode() && practice.task?.family === 'reading' && !practice.completed;
  $('replayTarget').disabled = busy || detector.active || !learning.target.length;
}

async function stop() {
  epoch++;
  if (mode === 'library') saveSongPlay().catch(fail);
  reading.pause();
  songStream.pause();
  previewing = null;
  listening = false;
  playbackScale = 1;
  controller?.abort();
  controller = null;
  piano.stop();
  if (microphone) {
    for (const track of microphone.getTracks()) { track.onended = null; track.stop(); }
  }
  microphone = null;
  if (capture) { capture.port.onmessage = null; capture.disconnect(); capture = null; }
  const closing = inputContext;
  inputContext = null;
  busy = false;
  calibrating = 0;
  setResumeAt(Infinity);
  resumeAtPerformance = -Infinity;
  playbackStart = null;
  latestLevel = 0;
  detector.reset();
  status(mode === 'reading' || mode === 'library' ? '' : 'Ready when you are');
  $('message').textContent = 'The microphone is off. Press space to play again.';
  buttons();
  learningReady();
  practiceReady();
  songReady();
  if (closing && closing.state !== 'closed') await closing.close();
}

async function fail(error) {
  await stop();
  console.error(error);
  status('Something needs attention', '#e9a698');
  const permission = error.name === 'NotAllowedError';
  $('error').textContent = permission
    ? 'Microphone access was denied. Allow it in your browser’s site settings and in macOS System Settings → Privacy & Security → Microphone, then try again.'
    : error.message;
  $('error').hidden = false;
}

async function initialize() {
  const savedThreshold = readLearnerSetting('piano-duet.note-confidence');
  if (savedThreshold !== null) {
    const value = Number(savedThreshold);
    if (!Number.isFinite(value) || value < 0.1 || value > 0.99) throw new Error('Saved note confidence must be between 0.10 and 0.99.');
    $('threshold').value = value;
    $('thresholdValue').textContent = value.toFixed(2);
  }
  const savedTempo = readLearnerSetting('piano-duet.reading-tempo');
  if (savedTempo !== null) {
    readingTempo = Number(savedTempo);
    if (!Number.isFinite(readingTempo) || readingTempo < TEMPO_LIMITS[0] || readingTempo > TEMPO_LIMITS[1]) throw new Error(`Saved reading tempo must be between ${TEMPO_LIMITS[0]} and ${TEMPO_LIMITS[1]} BPM.`);
  }
  const savedStage = localStorage.getItem('piano-duet.reading-stage');
  if (savedStage !== null) {
    replayStage = Number(savedStage);
    if (!Number.isInteger(replayStage) || replayStage < 1) throw new Error('The saved reading stage is invalid.');
  }
  const savedFlow = readLearnerSetting('piano-duet.drill-flow');
  if (savedFlow !== null) {
    if (!['build', 'mix'].includes(savedFlow)) throw new Error('The saved drill flow is invalid.');
    $('drillFlow').value = savedFlow;
  }
  const storedMode = readLearnerSetting('piano-duet.mode') || ENABLED_MODES[0];
  if (!ALL_MODES.includes(storedMode)) throw new Error('The saved playing mode is invalid.');
  const savedMode = ENABLED_MODES.includes(storedMode) ? storedMode : ENABLED_MODES[0];
  const response = await localFetch('/api/status');
  if (!response.ok) throw new Error('The local piano server is not available. Restart Piano Duet.');
  await Promise.all([piano.load(), sheet.ready()]);
  ready = true;
  await applyLearnerSettings(false);
  $('demo').hidden = true;
  $('answer').innerHTML = 'Finish attempt <kbd>space</kbd>';
  await Promise.all([refreshProfile(), loadPieces()]);
  if (savedMode !== mode) await selectMode(savedMode);
  else { updateModeControls(); await loadPractice(); }
  status(mode === 'reading' ? '' : 'Ready when you are');
  practiceReady();
  buttons();
}

async function startMicrophone() {
  showDrillOptions(false);
  $('error').hidden = true;
  busy = true;
  buttons();
  status('Waiting for microphone access…');
  $('message').textContent = 'Choose Allow when Chrome asks to use your microphone.';
  const generation = ++epoch;
  await context.resume();
  if (generation !== epoch) return;
  const deviceId = $('microphone').value;
  const stream = await navigator.mediaDevices.getUserMedia({audio: {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    channelCount: 1, ...(deviceId ? {deviceId: {exact: deviceId}} : {}),
  }});
  if (generation !== epoch) { stream.getTracks().forEach(track => track.stop()); return; }
  microphone = stream;
  inputContext = new AudioContext({sampleRate: 16000});
  inputContext.addEventListener('statechange', () => {
    if (inputContext?.state !== 'running') reading.interrupt();
  });
  if (inputContext.sampleRate !== 16000) throw new Error('This browser cannot capture at 16 kHz. Please use Chrome or Safari on your Mac.');
  if (typeof inputContext.getOutputTimestamp !== 'function') throw new Error('This browser cannot timestamp microphone audio.');
  await inputContext.audioWorklet.addModule(new URL('./capture.js', import.meta.url).href);
  if (generation !== epoch) return;
  capture = new AudioWorkletNode(inputContext, 'piano-capture');
  inputContext.createMediaStreamSource(stream).connect(capture).connect(inputContext.destination);
  calibrating = mode === 'reading' || mode === 'library' ? 0 : 16000;
  noiseSamples = [];
  detector.reset();
  const captureContext = inputContext;
  capture.port.onmessage = event => Promise.resolve().then(() => {
    const {samples, capturedAt} = event.data;
    processAudio(samples, capturePerformanceTime(capturedAt, captureContext.getOutputTimestamp(), captureContext.baseLatency));
  }).catch(fail);
  for (const track of stream.getTracks()) track.onended = () => fail(new Error('The microphone disconnected. Reconnect it and enable the microphone again.'));
  await inputContext.resume();
  const devices = await navigator.mediaDevices.enumerateDevices();
  const selected = stream.getAudioTracks()[0].getSettings().deviceId;
  $('microphone').replaceChildren(new Option('System default', ''));
  for (const device of devices.filter(device => device.kind === 'audioinput')) {
    $('microphone').add(new Option(device.label || 'Microphone', device.deviceId));
  }
  $('microphone').value = deviceId || selected || '';
  busy = false;
  if (calibrating) {
    status('A moment of quiet…');
    $('message').textContent = 'Stay quiet for one second while Duet measures the room. Then play a phrase.';
  } else practiceReady();
  buttons();
}

function processAudio(chunk, capturedAt) {
  latestLevel = Math.sqrt(chunk.reduce((sum, x) => sum + x * x, 0) / chunk.length);
  if (calibrating > 0) {
    noiseSamples.push(latestLevel);
    calibrating -= chunk.length;
    if (calibrating <= 0) {
      noiseSamples.sort((a, b) => a - b);
      detector.noise = noiseSamples[Math.floor(noiseSamples.length * 0.5)];
      status('Your turn. Play a little something.');
      $('message').textContent = 'Play for as long as you like. Press space when you want a reply.';
      learningReady();
      practiceReady();
    }
    return;
  }
  // The app's own playback must never be heard as the player's: whatever reset `busy`, nothing is
  // recorded while the piano or the metronome is still sounding in the room.
  const speakerUntil = performance.now() + (piano.audibleUntil - context.currentTime) * 1000;
  if (!captureAllowed(capturedAt, resumeAtPerformance, speakerUntil, busy && !Number.isFinite(resumeAt))) {
    if (detector.active) detector.reset();
    takeStarted = false;
    return;
  }
  if (busy) finishPlayback();
  if (mode === 'reading') { reading.feed(chunk); return; }
  if (mode === 'library') { if (song && !songEditor) songStream.feed(chunk); return; }
  if (isPracticeMode() && !practice.canPlay) return;
  detector.pause = Number($('pause').value);
  detector.gate = Number($('gate').value);
  detector.autoReply = mode !== 'drills' && $('autoReply').checked;
  let {phrase} = detector.feed(chunk);
  if (mode === 'drills') {
    const floor = Math.max(10 ** (detector.gate / 20), detector.noise * 3);
    if (detector.active && !takeStarted) {
      // The detector keeps a little audio from before the first sound; count attacks from there.
      attacks.reset();
      for (const part of detector.chunks) attacks.feed(part, floor);
      takeStarted = true;
      takeEnd = 'space';
      $('drillResults').hidden = true;
    } else if (detector.active) attacks.feed(chunk, floor);
    if (!phrase && drillIdle()) { detector.reset(); attacks.reset(); }
    if (!phrase && drillFinished()) phrase = detector.finish();
    if (!detector.active) takeStarted = false;
  }
  if (detector.active) {
    const seconds = Math.floor(detector.samples / 16000);
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    status(`Listening to your phrase… ${elapsed}`, '#e8b58f');
  }
  if (phrase) requestReply(phrase).catch(fail);
  buttons();
  if (!$('answer').disabled && document.activeElement === $('start')) $('answer').focus({preventScroll: true});
}

async function requestReply(audio, {source = 'microphone'} = {}) {
  const generation = epoch;
  takeStarted = false;
  const requestStage = learning.stage;
  if (mode === 'learning' && requestStage === 'idea') {
    clearLearning();
    learning.beginIdea(crypto.randomUUID());
    learningStep('listen', 'Finding the notes in your idea, then checking each pitch against the preceding notes…');
  } else if (mode === 'learning') {
    learningStep('repeat', 'Listening back to your attempt and comparing it with the practice target…');
  }
  busy = true;
  setResumeAt(Infinity);
  playbackStart = null;
  playbackEnd = 0;
  lateNotes = 0;
  controller = new AbortController();
  $('error').hidden = true;
  status('Finding the notes in your phrase…', '#e8b58f');
  $('message').textContent = isPracticeMode()
    ? 'Listening back to your performance and preparing your feedback.'
    : 'Listening back to your phrase and preparing a reply.';
  buttons();
  const params = new URLSearchParams({session, seconds: $('length').value,
    temperature: $('temperature').value, threshold: $('threshold').value, difficulty: $('difficulty').value, mode: mode === 'drills' ? 'drills' : isPracticeMode() ? 'practice' : mode, source,
    attempt: crypto.randomUUID()});
  if (isPracticeMode()) params.set('task', practice.task.id);
  if (mode === 'drills' && source === 'microphone') params.set('listening', JSON.stringify(takeListening()));
  if (mode === 'learning') {
    params.set('stage', requestStage);
    params.set('lesson', learning.id);
    params.set('surprise', Number($('surprise').value) / 100);
  }
  const response = await localFetch(`/api/respond?${params}`, {
    method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'X-Duet-Client': '1'},
    body: audio.buffer, signal: controller.signal,
  }).catch(error => {
    if (generation !== epoch && error.name === 'AbortError') return null;
    throw error;
  });
  if (!response || generation !== epoch) return;
  if (!response.ok) throw new Error((await response.json()).detail || 'The piano server could not process this phrase.');
  let completed = false;
  try {
    for await (const event of readEvents(response.body)) {
      if (generation !== epoch) return;
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'transcribing') {
        status(`Finding the notes in your phrase… ${Math.round(event.progress * 100)}%`, '#e8b58f');
      }
      if (event.type === 'analyzing') {
        status(`Checking note surprise… ${Math.round(event.progress * 100)}%`, '#e8b58f');
      }
      if (event.type === 'attempt' && source === 'microphone') lastAttempt = event.id;
      if (event.type === 'assessment') {
        practice.acceptAssessment(event);
        renderPractice(practice);
        if (mode === 'drills') showDrillResult(event.assessment).catch(fail);
        $('timing').textContent = event.assessment.score ? `${event.assessment.score.pitch_accuracy}% pitch accuracy · ${event.assessment.score.rhythm_accuracy ?? '—'}% relative rhythm` : 'No assessed notes yet.';
      }
      if (event.type === 'lesson') {
        learning.acceptLesson(event);
        renderAnalysis($('surpriseRows'), event.analysis);
        const changed = event.analysis.filter(note => note.changed).length;
        $('surpriseSummary').textContent = `${changed} of ${event.notes.length} pitches changed · see note-by-note surprise`;
        $('surpriseDetails').hidden = false;
        learningStep('listen', changed
          ? `Listen to your practice target: ${changed} pitch${changed === 1 ? '' : 'es'} changed. Your rhythm and note lengths are preserved.`
          : 'No pitches crossed the correction threshold. Listen to your idea, then play it back.');
      }
      if (event.type === 'score') {
        learning.acceptScore(event);
        turn++;
        $('turnCount').textContent = `LEARNING · ${turn} ROUND${turn === 1 ? '' : 'S'} COMPLETE`;
        $('learningScore').textContent = `${event.score} / 100`;
        const rhythm = event.rhythm_accuracy === null ? 'Rhythm: not enough matching notes to measure' : `Rhythm ${event.rhythm_accuracy}%`;
        $('learningFeedback').textContent = `Pitch accuracy ${event.pitch_accuracy}% · ${rhythm}. ${event.matched} notes matched, ${event.wrong} wrong pitches, ${event.missing} missing, ${event.extra} extra. Practice tempo: ${event.tempo_percent}% of the target.`;
        $('learningResult').hidden = false;
        $('timing').textContent = `Playback score: ${event.score} / 100`;
        learningReady();
      }
      if (event.type === 'heard') {
        heard = event.notes;
        reply = [];
        if (isPracticeMode() && heard.length) showPracticeTarget();
        // Drills report stats rather than engraving the performance.
        if (mode !== 'drills') sheet.heard(heard, event.key, isPracticeMode() ? {kind: 'attempt', label: 'Your performance'} : mode === 'learning'
          ? {kind: requestStage === 'repeat' ? 'attempt' : 'you', label: `${requestStage === 'repeat' ? 'Your playback' : 'Your idea'} · ${turn + 1}`}
          : {});
        if (event.key) showKey(event.key);
        exchangeOffset = transcript.length ? Math.max(...transcript.map(n => n.start + n.duration)) + 0.5 : 0;
        replyOffset = heard.length ? Math.max(...heard.map(n => n.start + n.duration)) + 0.5 : 0;
        transcript.push(...heard.map(n => ({...n, start: n.start + exchangeOffset})));
        $('emptyRoll').hidden = heard.length > 0 || (isPracticeMode() && practice.visible);
        status(heard.length ? `Heard ${heard.length} notes. ${isPracticeMode() ? 'Checking your performance…' : 'A reply is on its way…'}` : 'No piano notes detected.', '#e8b58f');
        $('timing').textContent = `${heard.length} notes heard · ${event.transcription_ms} ms transcription`;
      }
      if (event.type === 'note') {
        const note = event.note;
        if (playbackStart === null) playbackStart = context.currentTime + 0.4;
        let when = playbackStart + note.start;
        if (when < context.currentTime + 0.03) {
          const extra = context.currentTime + 0.12 - when;
          playbackStart += extra;
          when += extra;
          lateNotes++;
        }
        piano.play(note, when);
        playbackEnd = Math.max(playbackEnd, when + note.duration + 0.2);
        reply.push(note);
        sheet.reply(note, mode === 'learning' ? {kind: 'corrected', label: `Practice target · ${turn + 1}`} : {});
        if (mode === 'learning') targetScore = sheet.playing;
        transcript.push({...note, start: note.start + replyOffset + exchangeOffset});
        status(mode === 'learning' ? 'Listen to the practice target.' : 'Duet’s turn. Follow the thought.', '#95c8d2');
        $('message').textContent = mode === 'learning'
          ? 'The microphone is paused. Play this version back when the piano finishes.'
          : 'The microphone is paused while Duet plays. Your turn is coming next.';
      }
      if (event.type === 'done') {
        completed = true;
        if (event.notes) {
          if (mode === 'duet') turn++;
          $('turnCount').textContent = mode === 'learning' ? `LEARNING · ROUND ${turn + 1}` : `CONVERSATION · ${String(turn).padStart(2, '0')} EXCHANGES`;
          const lag = lateNotes ? ` · ${lateNotes} playback buffer adjustments` : '';
          $('timing').textContent = `${heard.length} heard · ${reply.length} replied · ${(event.first_note_ms / 1000).toFixed(2)} s to first note${lag}`;
        } else if (event.stage !== 'complete') {
          $('message').textContent = 'No piano notes were recognized. Try playing closer to the microphone, or lower Note confidence.';
        }
        setResumeAt(Math.max(context.currentTime, playbackEnd) + 0.75);
      }
    }
  } catch (error) {
    if (generation !== epoch && error.name === 'AbortError') return;
    throw error;
  }
  if (!completed) throw new Error('The local connection ended before the reply finished. Please restart the app.');
  await refreshProfile();
}

async function replayTarget() {
  if (!learning.target.length || busy) return;
  const generation = epoch;
  busy = true;
  setResumeAt(Infinity);
  detector.reset();
  buttons();
  await context.resume();
  if (generation !== epoch) return;
  reply = learning.target.map(note => ({...note}));
  sheet.playing = targetScore;
  playbackStart = context.currentTime + 0.15;
  playbackEnd = playbackStart;
  for (const note of reply) {
    piano.play(note, playbackStart + note.start);
    playbackEnd = Math.max(playbackEnd, playbackStart + note.start + note.duration + 0.2);
  }
  setResumeAt(playbackEnd + 0.75);
  learningStep('listen', 'Listen to the practice target again.');
  status('Playing the practice target.', '#95c8d2');
}

async function demo() {
  $('error').hidden = true;
  busy = true;
  buttons();
  await context.resume();
  const generation = ++epoch;
  const example = await piano.example();
  if (generation !== epoch) return;
  status('An example phrase, with both hands.', '#e8b58f');
  $('message').textContent = 'This sample goes through the same audio transcription and AI response as your microphone.';
  const start = context.currentTime + 0.1;
  for (const note of example.notes) piano.play(note, start + note.start);
  await new Promise(resolve => setTimeout(resolve, 4700));
  if (generation !== epoch) return;
  await requestReply(example.audio, {source: 'demo'});
}

function answer() {
  if (!microphone || busy || calibrating > 0) return;
  const phrase = detector.finish();
  if (phrase) requestReply(phrase).catch(fail);
}

async function exportMidi() {
  const response = await localFetch('/api/export', {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Duet-Client': '1'},
    body: JSON.stringify({notes: transcript})});
  if (!response.ok) throw new Error('The MIDI export failed. Your notes are still available in this session.');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'piano-duet.mid';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reset() {
  readingRevision++;
  readingNext = null;
  readingNextPromise = null;
  session = crypto.randomUUID();
  transcript = [];
  heard = [];
  reply = [];
  sheet.use(mode, SCORE_VIEWS[mode]);
  $('scoreError').hidden = true;
  $('keyName').textContent = 'Listening for a key…';
  $('keyDetail').textContent = 'Each reply follows the key of just your latest phrase.';
  if (mode === 'learning') $('keyDetail').textContent = 'Learning uses the model’s pitch probabilities; it preserves your original rhythm.';
  turn = 0;
  detector.reset();
  $('emptyRoll').hidden = false;
  $('turnCount').textContent = 'A FRESH CONVERSATION';
  $('timing').textContent = 'Listening happens here. Nothing leaves your Mac.';
  status(microphone ? 'Your turn. Play a little something.' : 'Ready when you are');
  $('message').textContent = microphone
    ? 'Play for as long as you like, then pause or press Answer now.'
    : 'Enable your microphone to play, or try a demo.';
  clearLearning();
  if (!isPracticeMode()) { practice.reset(); practiceScorePhrase = null; }
  buttons();
}

const canvas = $('roll');
const pen = canvas.getContext('2d');
function showKey(key) {
  $('keyName').textContent = `${key.name}${key.tentative ? ' · tentative' : ''}`;
  const names = key.scale_names.map(name => name.replaceAll('#', '♯').replaceAll('b', '♭')).join(' ');
  $('keyDetail').textContent = mode === 'learning'
    ? `Your idea’s estimated key. Learning suggestions use the model’s probabilities, without forcing a scale.`
    : isPracticeMode() ? `This exercise uses ${names}.${key.mode === 'minor' ? ' Natural minor.' : ''}`
      : `From your latest phrase. Replies use ${names}.${key.mode === 'minor' ? ' Natural minor.' : ''}`;
}
function drawRoll() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = devicePixelRatio;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  pen.setTransform(dpr, 0, 0, dpr, 0, 0);
  pen.clearRect(0, 0, width, height);
  const partner = isPracticeMode() ? (practice.visible ? practice.task.target : []) : reply;
  const partnerOffset = isPracticeMode() ? (heard.length ? Math.max(...heard.map(n => n.start + n.duration)) + 0.5 : 0) : replyOffset;
  const all = [...heard, ...partner.map(n => ({...n, start: n.start + partnerOffset}))];
  const lower = all.length ? Math.min(48, ...all.map(n => n.pitch)) - 3 : 42;
  const upper = all.length ? Math.max(76, ...all.map(n => n.pitch)) + 3 : 84;
  const seconds = Math.max(10, ...all.map(n => n.start + n.duration + 0.6));
  const left = 43, top = 20, bottom = height - 25;
  const x = time => left + time / seconds * (width - left - 20);
  const y = pitch => bottom - (pitch - lower) / (upper - lower) * (bottom - top);
  pen.lineWidth = 1;
  pen.font = '9px -apple-system, sans-serif';
  for (let pitch = Math.ceil(lower / 12) * 12; pitch <= upper; pitch += 12) {
    pen.strokeStyle = '#2a3532';
    pen.beginPath(); pen.moveTo(left, y(pitch)); pen.lineTo(width, y(pitch)); pen.stroke();
    pen.fillStyle = '#627c6f'; pen.fillText(`C${pitch / 12 - 1}`, 15, y(pitch) + 3);
  }
  for (let second = 0; second <= seconds; second += 2) {
    pen.strokeStyle = '#222e2a';
    pen.beginPath(); pen.moveTo(x(second), 0); pen.lineTo(x(second), bottom + 5); pen.stroke();
    pen.fillStyle = '#577063'; pen.fillText(`${second}s`, x(second), height - 8);
  }
  const noteHeight = Math.max(3, Math.min(7, (bottom - top) / (upper - lower) * 0.8));
  function notes(list, offset, color) {
    for (const note of list) {
      pen.fillStyle = color;
      pen.globalAlpha = 0.45 + note.velocity / 230;
      pen.beginPath();
      pen.roundRect(x(note.start + offset), y(note.pitch) - noteHeight / 2,
        Math.max(3, x(note.duration) - left), noteHeight, 2);
      pen.fill();
    }
    pen.globalAlpha = 1;
  }
  notes(heard, 0, '#e8b58f');
  notes(partner, partnerOffset, '#95c8d2');
  if (busy && playbackStart !== null) {
    const progress = context.currentTime - playbackStart;
    pen.strokeStyle = '#b5dce0'; pen.globalAlpha = 0.5;
    pen.beginPath(); pen.moveTo(x(partnerOffset + Math.max(0, progress)), 0);
    pen.lineTo(x(partnerOffset + Math.max(0, progress)), height - 18); pen.stroke(); pen.globalAlpha = 1;
  }
}

function finishPlayback() {
  busy = false;
  setResumeAt(Infinity);
  playbackStart = null;
  detector.reset();
  status(microphone ? 'Your turn. Take it somewhere.' : 'Ready when you are');
  if (reply.length) $('message').textContent = microphone
    ? 'Listening again. Build on the reply, or start a different idea.'
    : 'That was a local audio-to-piano duet. Enable your microphone to play your own phrase.';
  previewing = null;
  listening = false;
  playbackScale = 1;
  learningReady();
  practiceReady();
  songReady();
  buttons();
}

function draw() {
  if (!$('rollPanel').hidden) drawRoll();
  sheet.playback(busy && playbackStart !== null ? (context.currentTime - playbackStart) / playbackScale : null);
  const db = 20 * Math.log10(Math.max(latestLevel, 0.00001));
  const level = microphone ? Math.max(0, Math.min(100, (db + 65) / 60 * 100)) : 0;
  $('level').style.width = `${level}%`;
  $('level').parentElement.setAttribute('aria-valuenow', Math.round(level));
  $('levelText').textContent = microphone ? `${Math.round(db)} dB` : 'MIC OFF';
  if (busy && context.currentTime >= resumeAt) {
    finishPlayback();
  }
  if (previewing && busy && playbackStart !== null) previewTick();
  // Drills are transcribed afterwards, so the score follows the drill's tempo from the first note heard.
  if (mode === 'drills' && microphone && !busy && detector.active && !practice.completed && drillPlan) {
    sheet.follow(practiceScorePhrase, followPosition(drillPlan, attacks.count, attacks.seconds - (attacks.times.at(-1) ?? 0), playedGap(drillPlan, attacks.times)));
  }
  if (mode === 'drills' && $('drillSession').textContent !== sessionLabel()) $('drillSession').textContent = sessionLabel();
  requestAnimationFrame(draw);
}

$('start').addEventListener('click', () => (microphone || previewing ? stop() : startMicrophone()).catch(fail));
$('librarySearch').addEventListener('input', showLibrary);
$('chooseScore').addEventListener('click', () => $('libraryFile').click());
$('libraryFile').addEventListener('change', () => {
  $('importMenu').open = false;
  const [file] = $('libraryFile').files;
  $('libraryFile').value = '';
  if (file) importSong(file).catch(fail);
});
$('libraryPanel').addEventListener('dragover', event => { event.preventDefault(); $('libraryPanel').classList.add('dropping'); });
$('libraryPanel').addEventListener('dragleave', () => $('libraryPanel').classList.remove('dropping'));
$('libraryPanel').addEventListener('drop', event => {
  event.preventDefault();
  $('libraryPanel').classList.remove('dropping');
  for (const file of event.dataTransfer.files) importSong(file).catch(fail);
});
$('songBack').addEventListener('click', () => closeSong().catch(fail));
$('importMenu').addEventListener('click', event => { if (event.target.closest('button')) $('importMenu').open = false; });
$('openYoutube').addEventListener('click', () => { $('youtubeError').hidden = true; $('youtubeProgress').hidden = true; $('youtubeDialog').showModal(); });
$('youtubeForm').addEventListener('submit', event => importYoutube(event).catch(error => youtubeError(error.message)));
$('songEdit').addEventListener('click', () => openEditor().catch(fail));
$('editTempo').addEventListener('change', () => editAction(() => songEditor.setTempo(Number($('editTempo').value))));
$('editMeter').addEventListener('change', () => editAction(() => songEditor.setMeter($('editMeter').value)));
$('editKey').addEventListener('change', () => editAction(() => {
  const [tonic, keyMode] = $('editKey').value.split(':');
  songEditor.setKey(Number(tonic), keyMode);
}));
$('barsEarlier').addEventListener('click', () => editAction(() => songEditor.moveBarLines(1)));
$('barsLater').addEventListener('click', () => editAction(() => songEditor.moveBarLines(-1)));
$('editMore').addEventListener('click', () => {
  const button = $('editMore');
  button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') !== 'true');
});
$('editUndo').addEventListener('click', () => editAction(() => songEditor.undo()));
$('editSave').addEventListener('click', () => saveEdits().catch(fail));
$('editRevert').addEventListener('click', () => revertEdits().catch(fail));
$('editCancel').addEventListener('click', cancelEdits);
$('sheetMusic').addEventListener('click', event => editClick(event, false));
$('sheetMusic').addEventListener('dblclick', event => editClick(event, true));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('editMore').getAttribute('aria-expanded') === 'true') {
    $('editMore').setAttribute('aria-expanded', 'false');
    $('editMore').focus();
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (!songEditor || typing(event) || document.querySelector('dialog[open]')) return;
  const octave = event.shiftKey ? 12 : 1;
  const actions = {
    Delete: () => songEditor.remove(), Backspace: () => songEditor.remove(),
    ArrowUp: () => songEditor.transpose(octave), ArrowDown: () => songEditor.transpose(-octave),
    ArrowLeft: () => songEditor.step(-1), ArrowRight: () => songEditor.step(1),
    Escape: () => { songEditor.selected = null; },
  };
  const undo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z';
  if (!undo && !actions[event.key]) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  editAction(undo ? () => songEditor.undo() : actions[event.key]);
}, {capture: true});
$('songPreview').addEventListener('click', () => (previewing ? stop() : previewSong()).catch(fail));
$('stop').addEventListener('click', () => stop().catch(fail));
$('answer').addEventListener('click', answer);
$('demo').addEventListener('click', () => demo().catch(fail));
$('reset').addEventListener('click', reset);
$('export').addEventListener('click', () => exportMidi().catch(fail));
for (const value of ALL_MODES) {
  $(`${value}Mode`).hidden = !ENABLED_MODES.includes(value);
  $(`${value}Mode`).addEventListener('click', () => { $('modeMenuButton').setAttribute('aria-expanded', 'false'); selectMode(value).catch(fail); });
}
$('allProgress').hidden = !ENABLED_MODES.includes('practice');
$('modeMenuButton').addEventListener('click', () => {
  const button = $('modeMenuButton');
  button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') !== 'true');
});
$('drillMore').addEventListener('click', () => {
  const button = $('drillMore');
  button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') !== 'true');
});
document.addEventListener('click', event => {
  if (!event.target.closest('#modeMenu, #modeMenuButton')) $('modeMenuButton').setAttribute('aria-expanded', 'false');
  if (!event.target.closest('#drillExtra, #drillMore')) $('drillMore').setAttribute('aria-expanded', 'false');
  if (!event.target.closest('#editOptions, #editMore')) $('editMore').setAttribute('aria-expanded', 'false');
});
document.addEventListener('scroll', event => {
  $('drillMore').setAttribute('aria-expanded', 'false');
  if (!$('editOptions').contains(event.target)) $('editMore').setAttribute('aria-expanded', 'false');
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('modeMenuButton').setAttribute('aria-expanded', 'false');
    $('drillMore').setAttribute('aria-expanded', 'false');
    $('editMore').setAttribute('aria-expanded', 'false');
  }
});
$('nextPractice').addEventListener('click', () => loadPractice().catch(fail));
for (const id of ['drillKind', 'drillVariant', 'drillKey', 'drillHands', 'drillOctaves', 'drillInversion', 'drillPractice']) {
  $(id).addEventListener('change', () => { drills.sync(drills.read()); drills.save(); loadDrill(drills.next()); });
}
$('drillAuto').addEventListener('click', () => loadDrill({}));
$('drillNext').addEventListener('click', () => loadDrill(drills.next()));
$('drillFlow').addEventListener('change', () => { void writeLearnerSetting('piano-duet.drill-flow', $('drillFlow').value).catch(fail); });
$('drillLevel').addEventListener('click', () => openLevels().catch(fail));
$('drillSession').addEventListener('click', openSessionDialog);
for (const button of document.querySelectorAll('[data-session]')) {
  const [kind, amount] = button.dataset.session.split(':');
  button.addEventListener('click', () => startSession(kind, Number(amount)).catch(fail));
}
$('endSession').addEventListener('click', () => { $('sessionDialog').close(); endSession(); });
$('drillLast').addEventListener('click', () => { $('drillResults').hidden = !$('drillResults').hidden; });
$('drillSlower').addEventListener('click', () => changeDrillTempo(-1));
$('drillFaster').addEventListener('click', () => changeDrillTempo(1));
document.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || mode !== 'drills' || typing(event)
    || event.target === $('sheetMusic') || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  changeDrillTempo(event.key === 'ArrowLeft' ? -1 : 1);
});
$('skipPractice').addEventListener('click', () => { $('exerciseDialog').close(); loadPractice().catch(fail); });
$('reviewPractice').addEventListener('click', () => {
  $('assessmentDialog').close();
  $('profileDialog').showModal();
  inspectAttempt(practice.attemptId).catch(fail);
});
$('openProfile').addEventListener('click', () => {
  reading.interrupt();
  if (mode === 'reading') { openCareer(); return; }
  if (mode === 'drills' && !ENABLED_MODES.includes('practice')) { openLevels().catch(fail); return; }
  if (!ENABLED_MODES.includes('practice')) return;
  $('profileDialog').classList.remove('review-only');
  $('profileTitle').textContent = 'Your progress';
  $('profileDialog').showModal(); $('profileDialog').scrollTop = 0;
});
$('allProgress').addEventListener('click', () => { $('readingProgressDialog').close(); $('profileDialog').showModal(); });
for (const [button, dialog] of [['openSettings', 'settingsDialog'], ['fingerHelp', 'fingerDialog'], ['hudHelp', 'fingerDialog'],
  ['openExercise', 'exerciseDialog'], ['drillDetails', 'exerciseDialog'], ['openAssessment', 'assessmentDialog'], ['openAnalysis', 'analysisDialog']]) {
  $(button).addEventListener('click', () => { reading.interrupt(); $(dialog).showModal(); $(dialog).scrollTop = 0; });
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => reading.interrupt());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
$('practiceFocus').addEventListener('change', () => {
  $('pieceChoice').hidden = $('practiceFocus').value !== 'repertoire';
  loadPractice().catch(fail);
});
$('practicePiece').addEventListener('change', () => loadPractice().catch(fail));
$('hearPractice').addEventListener('click', () => { $('fingerDialog').close(); toggleListening(); });
$('hudListen').addEventListener('click', toggleListening);
$('drillListen').addEventListener('click', toggleListening);
$('drillToggle').addEventListener('click', () => showDrillOptions($('drillOptions').hidden));
for (const id of ['practiceBeat', 'hudBeat', 'drillBeat']) $(id).addEventListener('click', () => hearBeat().catch(fail));
$('tempoDown').addEventListener('click', () => changeTempo(-1));
$('hudReplay').addEventListener('click', () => chooseStage(null));
$('tempoUp').addEventListener('click', () => changeTempo(1));
document.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || mode !== 'reading' || typing(event) || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  changeTempo(event.key === 'ArrowLeft' ? -1 : 1);
});
$('practiceHelp').addEventListener('toggle', () => { if ($('practiceHelp').open && practice.task && !practice.completed) practiceAid('hints').catch(fail); });
$('revealPractice').addEventListener('click', () => practiceAid('reveals').catch(fail));
$('excludePractice').addEventListener('click', () => excludeAttempt(practice.attemptId, !practice.excluded).catch(fail));
$('savePieceForm').addEventListener('submit', event => savePiece(event).catch(fail));
$('replayTarget').addEventListener('click', () => replayTarget().catch(fail));
$('newRound').addEventListener('click', () => { clearLearning(); detector.reset(); buttons(); });
$('autoReply').addEventListener('change', () => { $('pause').disabled = !$('autoReply').checked; automaticPause[mode] = $('autoReply').checked; void writeLearnerSetting(`piano-duet.autoReply.${mode}`, String($('autoReply').checked)).catch(fail); });
for (const view of ['sheet', 'roll']) {
  $(`${view}View`).addEventListener('click', () => {
    $('sheetPanel').hidden = view !== 'sheet';
    $('rollPanel').hidden = view !== 'roll';
    $('sheetView').setAttribute('aria-pressed', view === 'sheet');
    $('rollView').setAttribute('aria-pressed', view === 'roll');
  });
}
for (const id of ['scoreTempo', 'scoreBpm', 'scoreMeter', 'scoreAccidentals']) {
  $(id).addEventListener('change', () => {
    $('bpmLabel').hidden = $('scoreTempo').value !== 'manual';
    const manual = $('scoreTempo').value === 'manual';
    if (manual && !$('scoreBpm').reportValidity()) return;
    sheet.configure({tempo: $('scoreTempo').value, bpm: manual ? Number($('scoreBpm').value) : sheet.options.bpm,
      meter: $('scoreMeter').value, flats: $('scoreAccidentals').value === 'auto' ? null : $('scoreAccidentals').value === 'flats'});
  });
}
function typing(event) {
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) || event.target.isContentEditable;
}
function space() {
  if (songEditor) return;
  if (previewing) stop().catch(fail);
  else if (!microphone) { if (!$('start').disabled) startMicrophone().catch(fail); }
  else if (mode === 'reading' || mode === 'library') stop().catch(fail);
  else answer();
}
// Space is the one playing control everywhere, so it never activates the focused button instead.
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || typing(event) || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (event.repeat) return;
  $('start').classList.add('pressed');
  space();
}, {capture: true});
document.addEventListener('keyup', event => {
  if (event.code !== 'Space' || typing(event) || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  $('start').classList.remove('pressed');
}, {capture: true});
const labels = {
  pause: value => `${Number(value).toFixed(1)} s`, length: value => `~${value} s`,
  temperature: value => Number(value) < 0.8 ? 'Familiar' : Number(value) > 1.05 ? 'Adventurous' : 'Balanced',
  difficulty: value => `${value} · ${['Gentle', 'Easy', 'Moderate', 'Advanced', 'Expert'][Number(value) - 1]}`,
  volume: value => `${value}%`, gate: value => `${value} dB`,
  threshold: value => Number(value).toFixed(2),
  surprise: value => `${Number(value).toFixed(1)}%`,
};
for (const [id, format] of Object.entries(labels)) {
  $(id).addEventListener('input', () => {
    $(`${id}Value`).textContent = format($(id).value);
    if (id === 'volume') piano.gain.gain.setTargetAtTime(Number($(id).value) / 100, context.currentTime, 0.03);
  });
}
for (const id of ['threshold', 'pause', 'length', 'difficulty', 'temperature', 'surprise', 'scoreTempo', 'scoreBpm', 'scoreMeter', 'scoreAccidentals']) {
  $(id).addEventListener('change', () => { void writeLearnerSetting(`piano-duet.${id === 'threshold' ? 'note-confidence' : id}`, $(id).value).catch(fail); });
}
async function applyLearnerSettings(selectSavedMode = true) {
  for (const id of ['threshold', 'pause', 'length', 'difficulty', 'temperature', 'surprise', 'scoreTempo', 'scoreBpm', 'scoreMeter', 'scoreAccidentals']) {
    const value = readLearnerSetting(`piano-duet.${id === 'threshold' ? 'note-confidence' : id}`);
    if (value === null) continue;
    $(id).value = value;
    if (labels[id]) $(`${id}Value`).textContent = labels[id](value);
  }
  for (const name of Object.keys(automaticPause)) {
    const value = readLearnerSetting(`piano-duet.autoReply.${name}`);
    if (value !== null) automaticPause[name] = value === 'true';
  }
  $('autoReply').checked = automaticPause[mode];
  $('pause').disabled = !$('autoReply').checked;
  const tempo = readLearnerSetting('piano-duet.reading-tempo');
  if (tempo !== null) readingTempo = Number(tempo);
  const flow = readLearnerSetting('piano-duet.drill-flow');
  if (flow !== null) $('drillFlow').value = flow;
  if (drills.catalog && drills.saved()) drills.sync(drills.saved());
  $('bpmLabel').hidden = $('scoreTempo').value !== 'manual';
  sheet.configure({tempo: $('scoreTempo').value, bpm: Number($('scoreBpm').value), meter: $('scoreMeter').value,
    flats: $('scoreAccidentals').value === 'auto' ? null : $('scoreAccidentals').value === 'flats'});
  const selected = readLearnerSetting('piano-duet.mode');
  if (selectSavedMode && selected && !ALL_MODES.includes(selected)) throw new Error('The saved playing mode is invalid.');
  if (selectSavedMode && selected && ENABLED_MODES.includes(selected) && selected !== mode) await selectMode(selected, false);
}
window.addEventListener('pagehide', () => { controller?.abort(); microphone?.getTracks().forEach(track => track.stop()); piano.stop(); });
const initialized = initialize();
initialized.catch(fail);
draw();
