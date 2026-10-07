import {PhraseDetector, PianoSound, readEvents} from './audio.mjs';
import {SheetMusic} from './sheet.mjs';
import {LearningCycle, renderAnalysis} from './learning.mjs';
import {PracticeCycle, localRequest, renderPractice, renderProfile, renderAttempt} from './practice.mjs';

const $ = id => document.getElementById(id);
const sheet = new SheetMusic($('sheetMusic'));
sheet.onPage = ({index, total}) => {
  $('pageLabel').textContent = total ? `${index + 1} / ${total}` : '—';
  $('previousPage').disabled = !total || index === 0;
  $('nextPage').disabled = !total || index === total - 1;
};
sheet.onError = error => {
  console.error(error);
  $('scoreError').textContent = `Sheet music could not render: ${error.message}`;
  $('scoreError').hidden = false;
};
sheet.clear();
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
let mode = 'practice';
const learning = new LearningCycle();
const practice = new PracticeCycle();
const automaticPause = {practice: false, duet: true, learning: true};
let practiceScorePhrase = null;
let lastAttempt = null;
let targetScore = null;

function practiceReady() {
  if (mode !== 'practice' || !practice.task) return;
  renderPractice(practice);
  if (practice.completed) {
    status('Attempt complete. Your profile is up to date.');
    $('message').textContent = 'Review your feedback below, then choose Next exercise.';
  } else if (!practice.canPlay) {
    status('Listen to the melody first.');
    $('message').textContent = 'Choose Hear melody, then play it back on your piano.';
  } else {
    status(microphone ? 'Listening. Take your time.' : 'Ready when you are.');
    $('message').textContent = microphone
      ? 'Play the exercise, then press Finish attempt or space. There is no time limit.'
      : 'Enable your microphone below, then play the exercise on your piano.';
  }
}

function showPracticeTarget() {
  if (practiceScorePhrase) return;
  const task = practice.task;
  $('sheetMusic').querySelector('.practice-hidden')?.remove();
  practiceScorePhrase = sheet.addPhrase('target', task.target, task.bpm || 60, task.key, task.title);
  $('emptyRoll').hidden = true;
}

async function refreshProfile() {
  const profile = await localRequest('/api/profile');
  renderProfile(profile, id => inspectAttempt(id).catch(fail));
  if (profile.recent.length) lastAttempt = profile.recent.find(attempt => attempt.note_count > 0)?.id || null;
  $('savePieceForm').hidden = !lastAttempt;
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
  busy = true;
  detector.reset();
  buttons();
  status('Choosing your next step…');
  const task = await localRequest('/api/practice/next', {focus: $('practiceFocus').value,
    ...($('practicePiece').value && $('practiceFocus').value === 'repertoire' ? {piece: $('practicePiece').value} : {})});
  if (task.family === 'repertoire') await loadPieces();
  if (generation !== epoch || mode !== 'practice') return;
  practice.acceptTask(task);
  for (const details of $('exerciseDialog').querySelectorAll('details')) details.open = false;
  heard = []; reply = []; transcript = [];
  sheet.clear();
  practiceScorePhrase = null;
  $('scoreError').hidden = true;
  if (practice.visible) showPracticeTarget();
  else {
    $('sheetMusic').replaceChildren();
    const placeholder = document.createElement('p');
    placeholder.className = 'practice-hidden';
    placeholder.textContent = task.family === 'ear' ? 'Let your ears lead. Hear the melody, then find it on the keys.' : 'Find the notes yourself. Reveal the score whenever you need help.';
    $('sheetMusic').append(placeholder);
  }
  showKey(task.key);
  $('turnCount').textContent = `${task.family.toUpperCase()} · STAGE ${task.challenge}`;
  $('emptyRoll').hidden = practice.visible;
  if (task.family === 'reading') {
    $('sheetPanel').hidden = false; $('rollPanel').hidden = true; $('scorePages').hidden = false;
    $('sheetView').setAttribute('aria-pressed', true); $('rollView').setAttribute('aria-pressed', false);
  }
  $('timing').textContent = 'Your exercise';
  busy = false;
  practiceReady();
  buttons();
}

async function practiceAid(kind) {
  if (!practice.task || busy) return;
  const generation = epoch;
  busy = true;
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
    $('sheetPanel').hidden = false; $('rollPanel').hidden = true; $('scorePages').hidden = false;
    $('sheetView').setAttribute('aria-pressed', true); $('rollView').setAttribute('aria-pressed', false);
    busy = false;
    practiceReady(); buttons();
    return;
  }
  await context.resume();
  if (generation !== epoch) return;
  playbackStart = context.currentTime + 0.2;
  playbackEnd = playbackStart;
  sheet.replyPhrase = practiceScorePhrase;
  for (const note of practice.task.target) {
    piano.play(note, playbackStart + note.start);
    playbackEnd = Math.max(playbackEnd, playbackStart + note.start + note.duration + 0.2);
  }
  resumeAt = playbackEnd + 0.75;
  status('Listen to the example.', '#95c8d2');
  $('message').textContent = 'The microphone waits while the piano plays.';
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
  const generation = epoch;
  busy = true; resumeAt = Infinity; buttons();
  await context.resume();
  if (generation !== epoch) return;
  const beat = 60 / practice.task.bpm;
  const start = context.currentTime + 0.1;
  for (let i = 0; i < 4; i++) {
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = i === 0 ? 1000 : 700;
    gain.gain.setValueAtTime(0.09, start + i * beat);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + i * beat + 0.06);
    tone.connect(gain).connect(piano.gain);
    tone.start(start + i * beat); tone.stop(start + i * beat + 0.07);
    piano.sources.add(tone);
    tone.onended = () => { piano.sources.delete(tone); tone.disconnect(); gain.disconnect(); };
  }
  resumeAt = start + 4 * beat + 0.3;
  status(`${practice.task.bpm} BPM · find a comfortable pulse.`);
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

function selectMode(value) {
  if (value === mode) return;
  mode = value;
  $('practiceMode').setAttribute('aria-pressed', value === 'practice');
  $('duetMode').setAttribute('aria-pressed', value === 'duet');
  $('learningMode').setAttribute('aria-pressed', value === 'learning');
  $('learningPanel').hidden = value !== 'learning';
  $('learningSettings').hidden = value !== 'learning';
  $('duetSettings').hidden = value !== 'duet';
  $('practicePanel').hidden = value !== 'practice';
  $('practiceSettings').hidden = value !== 'practice';
  $('keyCaption').textContent = value === 'practice' ? 'KEY OF THIS EXERCISE' : 'KEY OF YOUR LATEST PHRASE';
  $('notationHelp').textContent = value === 'practice'
    ? 'Exercise notation follows the task. Tempo and meter controls apply to your transcribed performance.'
    : 'Approximate written rhythms. Tempo and meter change the score; playback keeps your timing.';
  $('demo').hidden = value === 'practice';
  $('answer').innerHTML = value === 'practice' ? 'Finish attempt <kbd>space</kbd>' : 'Answer now <kbd>space</kbd>';
  $('autoReply').checked = automaticPause[value];
  $('pause').disabled = !$('autoReply').checked;
  $('partnerLabel').textContent = value === 'practice' ? 'Exercise' : value === 'learning' ? 'Practice target' : 'Duet';
  $('modeDescription').textContent = value === 'practice' ? 'Personal practice, shaped by what you play.' : value === 'learning'
    ? 'Play an idea, hear a variation, then play it back for a score.'
    : 'Trade musical ideas with your AI piano partner.';
  $('modeDescription').hidden = value !== 'duet';
  reset();
  if (value === 'practice') loadPractice().catch(fail);
}

function status(text, color = '#9ab89d') {
  $('status').textContent = text;
  $('statusDot').style.background = color;
}

function buttons() {
  $('start').disabled = !ready || (!microphone && busy);
  $('start').setAttribute('aria-pressed', Boolean(microphone));
  $('start').classList.toggle('primary', !microphone);
  $('micLabel').textContent = microphone ? 'Turn mic off' : 'Enable microphone';
  $('answer').disabled = !microphone || busy || calibrating > 0 || !detector.active;
  $('answer').hidden = !microphone || busy || (mode === 'practice' && (!practice.canPlay || practice.completed));
  $('nextPractice').hidden = mode !== 'practice' || !practice.completed || busy;
  $('stop').disabled = !microphone && !busy;
  $('stop').hidden = !busy;
  $('demo').disabled = !ready || busy || Boolean(microphone) || (mode === 'learning' && learning.stage === 'repeat');
  $('demo').hidden = mode === 'practice' || Boolean(microphone) || (mode === 'learning' && learning.stage === 'repeat');
  $('reset').disabled = busy || transcript.length === 0;
  $('reset').hidden = mode === 'practice' || transcript.length === 0;
  $('export').disabled = busy || transcript.length === 0;
  $('export').hidden = transcript.length === 0;
  $('microphone').disabled = Boolean(microphone) || busy;
  for (const id of ['duetMode', 'learningMode', 'newRound']) $(id).disabled = busy || detector.active;
  for (const id of ['practiceMode', 'practiceFocus', 'practicePiece', 'nextPractice', 'skipPractice']) $(id).disabled = !ready || busy || detector.active;
  for (const id of ['hearPractice', 'revealPractice', 'practiceBeat']) $(id).disabled = !ready || busy || detector.active || !practice.task;
  $('practiceHelp').inert = busy || detector.active;
  $('openAnalysis').hidden = mode !== 'learning' || $('surpriseDetails').hidden;
  $('hearPractice').classList.toggle('primary', !practice.canPlay && !practice.completed);
  $('hearPractice').classList.toggle('secondary', practice.canPlay || practice.completed);
  $('rollView').disabled = mode === 'practice' && practice.task?.family === 'reading' && !practice.completed;
  $('replayTarget').disabled = busy || detector.active || !learning.target.length;
}

async function stop() {
  epoch++;
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
  resumeAt = Infinity;
  playbackStart = null;
  latestLevel = 0;
  detector.reset();
  status('Ready when you are');
  $('message').textContent = 'The microphone is off. Enable it whenever you want to play again.';
  buttons();
  learningReady();
  practiceReady();
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
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error('The local piano server is not available. Restart Piano Duet.');
  await Promise.all([piano.load(), sheet.ready()]);
  ready = true;
  $('autoReply').checked = false;
  $('pause').disabled = true;
  $('demo').hidden = true;
  $('answer').innerHTML = 'Finish attempt <kbd>space</kbd>';
  await Promise.all([refreshProfile(), loadPieces()]);
  await loadPractice();
  status('Ready when you are');
  practiceReady();
  buttons();
}

async function startMicrophone() {
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
  if (inputContext.sampleRate !== 16000) throw new Error('This browser cannot capture at 16 kHz. Please use Chrome or Safari on your Mac.');
  await inputContext.audioWorklet.addModule('/static/capture.js');
  if (generation !== epoch) return;
  capture = new AudioWorkletNode(inputContext, 'piano-capture');
  inputContext.createMediaStreamSource(stream).connect(capture).connect(inputContext.destination);
  calibrating = 16000;
  noiseSamples = [];
  detector.reset();
  capture.port.onmessage = event => processAudio(event.data);
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
  status('A moment of quiet…');
  $('message').textContent = 'Stay quiet for one second while Duet measures the room. Then play a phrase.';
  buttons();
}

function processAudio(chunk) {
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
  if (busy) return;
  if (mode === 'practice' && !practice.canPlay) return;
  detector.pause = Number($('pause').value);
  detector.gate = Number($('gate').value);
  detector.autoReply = $('autoReply').checked;
  const {phrase} = detector.feed(chunk);
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
  const requestStage = learning.stage;
  if (mode === 'learning' && requestStage === 'idea') {
    clearLearning();
    learning.beginIdea(crypto.randomUUID());
    learningStep('listen', 'Finding the notes in your idea, then checking each pitch against the preceding notes…');
  } else if (mode === 'learning') {
    learningStep('repeat', 'Listening back to your attempt and comparing it with the practice target…');
  }
  busy = true;
  resumeAt = Infinity;
  playbackStart = null;
  playbackEnd = 0;
  lateNotes = 0;
  controller = new AbortController();
  $('error').hidden = true;
  status('Finding the notes in your phrase…', '#e8b58f');
  $('message').textContent = mode === 'practice'
    ? 'Listening back to your performance and preparing your feedback.'
    : 'Listening back to your phrase and preparing a reply.';
  buttons();
  const params = new URLSearchParams({session, seconds: $('length').value,
    temperature: $('temperature').value, threshold: $('threshold').value, difficulty: $('difficulty').value, mode, source,
    attempt: crypto.randomUUID()});
  if (mode === 'practice') params.set('task', practice.task.id);
  if (mode === 'learning') {
    params.set('stage', requestStage);
    params.set('lesson', learning.id);
    params.set('surprise', Number($('surprise').value) / 100);
  }
  const response = await fetch(`/api/respond?${params}`, {
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
        const rhythm = event.rhythm_accuracy === null ? 'Rhythm: not enough matching attacks to measure' : `Rhythm ${event.rhythm_accuracy}%`;
        $('learningFeedback').textContent = `Pitch accuracy ${event.pitch_accuracy}% · ${rhythm}. ${event.matched} notes matched, ${event.wrong} wrong pitches, ${event.missing} missing, ${event.extra} extra. Practice tempo: ${event.tempo_percent}% of the target.`;
        $('learningResult').hidden = false;
        $('timing').textContent = `Playback score: ${event.score} / 100`;
        learningReady();
      }
      if (event.type === 'heard') {
        heard = event.notes;
        reply = [];
        if (mode === 'practice' && heard.length) showPracticeTarget();
        sheet.heard(heard, event.key, mode === 'practice' ? {kind: 'attempt', label: 'Your performance'} : mode === 'learning'
          ? {kind: requestStage === 'repeat' ? 'attempt' : 'you', label: `${requestStage === 'repeat' ? 'Your playback' : 'Your idea'} · ${turn + 1}`}
          : {});
        if (event.key) showKey(event.key);
        exchangeOffset = transcript.length ? Math.max(...transcript.map(n => n.start + n.duration)) + 0.5 : 0;
        replyOffset = heard.length ? Math.max(...heard.map(n => n.start + n.duration)) + 0.5 : 0;
        transcript.push(...heard.map(n => ({...n, start: n.start + exchangeOffset})));
        $('emptyRoll').hidden = heard.length > 0 || (mode === 'practice' && practice.visible);
        status(heard.length ? `Heard ${heard.length} notes. A reply is on its way…` : 'No piano notes detected.', '#e8b58f');
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
        if (mode === 'learning') targetScore = sheet.replyPhrase;
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
        resumeAt = Math.max(context.currentTime, playbackEnd) + 0.75;
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
  resumeAt = Infinity;
  detector.reset();
  buttons();
  await context.resume();
  if (generation !== epoch) return;
  reply = learning.target.map(note => ({...note}));
  sheet.replyPhrase = targetScore;
  playbackStart = context.currentTime + 0.15;
  playbackEnd = playbackStart;
  for (const note of reply) {
    piano.play(note, playbackStart + note.start);
    playbackEnd = Math.max(playbackEnd, playbackStart + note.start + note.duration + 0.2);
  }
  resumeAt = playbackEnd + 0.75;
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
  const response = await fetch('/api/export', {method: 'POST',
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
  session = crypto.randomUUID();
  transcript = [];
  heard = [];
  reply = [];
  sheet.clear();
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
  if (mode !== 'practice') { practice.reset(); practiceScorePhrase = null; }
  buttons();
}

const canvas = $('roll');
const pen = canvas.getContext('2d');
function showKey(key) {
  $('keyName').textContent = `${key.name}${key.tentative ? ' · tentative' : ''}`;
  const names = key.scale_names.map(name => name.replaceAll('#', '♯').replaceAll('b', '♭')).join(' ');
  $('keyDetail').textContent = mode === 'learning'
    ? `Your idea’s estimated key. Learning suggestions use the model’s probabilities, without forcing a scale.`
    : mode === 'practice' ? `This exercise uses ${names}.${key.mode === 'minor' ? ' Natural minor.' : ''}`
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
  const partner = mode === 'practice' ? (practice.visible ? practice.task.target : []) : reply;
  const partnerOffset = mode === 'practice' ? (heard.length ? Math.max(...heard.map(n => n.start + n.duration)) + 0.5 : 0) : replyOffset;
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

function draw() {
  if (!$('rollPanel').hidden) drawRoll();
  sheet.playback(busy && playbackStart !== null ? context.currentTime - playbackStart : null);
  const db = 20 * Math.log10(Math.max(latestLevel, 0.00001));
  const level = microphone ? Math.max(0, Math.min(100, (db + 65) / 60 * 100)) : 0;
  $('level').style.width = `${level}%`;
  $('level').parentElement.setAttribute('aria-valuenow', Math.round(level));
  $('levelText').textContent = microphone ? `${Math.round(db)} dB` : 'MIC OFF';
  if (busy && context.currentTime >= resumeAt) {
    busy = false;
    resumeAt = Infinity;
    playbackStart = null;
    detector.reset();
    status(microphone ? 'Your turn. Take it somewhere.' : 'Ready when you are');
    if (reply.length) $('message').textContent = microphone
      ? 'Listening again. Build on the reply, or start a different idea.'
      : 'That was a local audio-to-piano duet. Enable your microphone to play your own phrase.';
    learningReady();
    practiceReady();
    buttons();
  }
  requestAnimationFrame(draw);
}

$('start').addEventListener('click', () => (microphone ? stop() : startMicrophone()).catch(fail));
$('stop').addEventListener('click', () => stop().catch(fail));
$('answer').addEventListener('click', answer);
$('demo').addEventListener('click', () => demo().catch(fail));
$('reset').addEventListener('click', reset);
$('export').addEventListener('click', () => exportMidi().catch(fail));
$('duetMode').addEventListener('click', () => selectMode('duet'));
$('learningMode').addEventListener('click', () => selectMode('learning'));
$('practiceMode').addEventListener('click', () => selectMode('practice'));
$('nextPractice').addEventListener('click', () => loadPractice().catch(fail));
$('skipPractice').addEventListener('click', () => { $('exerciseDialog').close(); loadPractice().catch(fail); });
$('reviewPractice').addEventListener('click', () => {
  $('assessmentDialog').close();
  $('profileDialog').showModal();
  inspectAttempt(practice.attemptId).catch(fail);
});
for (const [button, dialog] of [['openSettings', 'settingsDialog'], ['openProfile', 'profileDialog'],
  ['openExercise', 'exerciseDialog'], ['openAssessment', 'assessmentDialog'], ['openAnalysis', 'analysisDialog']]) {
  $(button).addEventListener('click', () => { $(dialog).showModal(); $(dialog).scrollTop = 0; });
  $(dialog).addEventListener('click', event => {
    if (event.target !== $(dialog)) return;
    const bounds = $(dialog).getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $(dialog).close();
  });
}
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
$('practiceFocus').addEventListener('change', () => {
  $('pieceChoice').hidden = $('practiceFocus').value !== 'repertoire';
  loadPractice().catch(fail);
});
$('practicePiece').addEventListener('change', () => loadPractice().catch(fail));
$('previousPage').addEventListener('click', () => sheet.turnPage(-1));
$('nextPage').addEventListener('click', () => sheet.turnPage(1));
$('sheetMusic').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  sheet.turnPage(event.key === 'ArrowLeft' ? -1 : 1);
});
$('hearPractice').addEventListener('click', () => practiceAid('hearings').catch(fail));
$('practiceBeat').addEventListener('click', () => hearBeat().catch(fail));
$('practiceHelp').addEventListener('toggle', () => { if ($('practiceHelp').open && practice.task && !practice.completed) practiceAid('hints').catch(fail); });
$('revealPractice').addEventListener('click', () => practiceAid('reveals').catch(fail));
$('excludePractice').addEventListener('click', () => excludeAttempt(practice.attemptId, !practice.excluded).catch(fail));
$('savePieceForm').addEventListener('submit', event => savePiece(event).catch(fail));
$('replayTarget').addEventListener('click', () => replayTarget().catch(fail));
$('newRound').addEventListener('click', () => { clearLearning(); detector.reset(); buttons(); });
$('autoReply').addEventListener('change', () => { $('pause').disabled = !$('autoReply').checked; automaticPause[mode] = $('autoReply').checked; });
for (const view of ['sheet', 'roll']) {
  $(`${view}View`).addEventListener('click', () => {
    $('sheetPanel').hidden = view !== 'sheet';
    $('rollPanel').hidden = view !== 'roll';
    $('sheetView').setAttribute('aria-pressed', view === 'sheet');
    $('rollView').setAttribute('aria-pressed', view === 'roll');
    $('scorePages').hidden = view !== 'sheet';
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
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  if (event.code !== 'Space' || ['INPUT', 'SELECT', 'BUTTON', 'SUMMARY'].includes(event.target.tagName)) return;
  event.preventDefault();
  answer();
});
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
window.addEventListener('pagehide', () => { controller?.abort(); microphone?.getTracks().forEach(track => track.stop()); piano.stop(); });
initialize().catch(fail);
draw();
