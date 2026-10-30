import {pitchName} from './learning.mjs';

const $ = id => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function tone(accuracy) {
  return accuracy === null ? 'var(--line-strong)' : accuracy >= 90 ? 'var(--green)' : accuracy >= 75 ? 'var(--gold)' : 'var(--red)';
}

export function ago(seconds, now = Date.now() / 1000) {
  if (seconds === null) return '—';
  const minutes = (now - seconds) / 60;
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 60 / 24)} d ago`;
}

const duration = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function renderLibrary(library, query, {onOpen, onImport, onDelete}) {
  const rows = $('songRows');
  rows.replaceChildren();
  const match = item => `${item.title} ${item.artist || ''}`.toLowerCase().includes(query.trim().toLowerCase());
  const songs = library.songs.filter(match);
  songs.forEach((song, i) => {
    const row = element('div', 'song-row');
    row.setAttribute('role', 'row');
    row.tabIndex = 0;
    const meter = element('span', 'song-meter');
    const bar = element('i');
    bar.style.width = `${song.accuracy ?? 0}%`;
    bar.style.background = tone(song.accuracy);
    meter.append(element('span', 'song-track'), element('b', '', song.accuracy === null ? '—' : `${song.accuracy}%`));
    meter.firstChild.append(bar);
    const title = element('span', 'song-name');
    title.append(element('strong', '', song.title), element('small', '', song.artist || `${song.key} · ${song.meter}`));
    const remove = element('button', 'icon-button song-delete', '✕');
    remove.setAttribute('aria-label', `Remove ${song.title}`);
    remove.addEventListener('click', event => { event.stopPropagation(); onDelete(song); });
    row.append(element('span', 'song-index', String(i + 1)), title, element('span', '', song.plays ? String(song.plays) : 'New'),
      meter, element('span', '', song.best === null ? '—' : `${song.best}%`), element('span', '', `${song.coverage}%`),
      element('span', '', ago(song.last_played)), element('span', '', duration(song.seconds)), remove);
    row.addEventListener('click', () => onOpen(song.id));
    row.addEventListener('keydown', event => { if (event.key === 'Enter') onOpen(song.id); });
    rows.append(row);
  });
  $('songEmpty').hidden = songs.length > 0;
  $('songEmpty').textContent = library.songs.length ? 'No songs match your search.' : 'Import a MIDI or MusicXML file to start your library.';
  const catalog = $('catalogRows');
  catalog.replaceChildren();
  for (const item of library.catalog.filter(match)) {
    const row = element('div', 'catalog-row');
    const title = element('span', 'song-name');
    title.append(element('strong', '', item.title), element('small', '', item.artist));
    const get = element('a', 'text-button', 'Get sheet music ↗');
    get.href = item.url;
    get.target = '_blank';
    get.rel = 'noopener';
    const add = element('button', 'secondary', 'Import file');
    add.addEventListener('click', () => onImport(item));
    row.append(title, get, add);
    catalog.append(row);
  }
  $('catalogHeading').hidden = !catalog.childElementCount;
}

export function sessionAccuracy(progress) {
  const values = [...progress.results.values()];
  return values.length ? Math.round(100 * values.filter(Boolean).length / values.length) : null;
}

export function currentOrdinal(progress) {
  const ordinal = progress.attacks.findIndex(attack => attack.indices[0] >= progress.index);
  return ordinal === -1 ? progress.attacks.length : ordinal;
}

export function renderSongHud(song, stats, progress, onJump) {
  $('songTitle').textContent = song.title;
  $('songArtist').textContent = song.artist || `${song.key.name} · ${song.meter} · ♩ = ${song.bpm}`;
  const ordinal = currentOrdinal(progress);
  const strip = $('songSections');
  if (strip.dataset.song !== song.id || strip.children.length !== stats.sections.length) {
    strip.replaceChildren(...stats.sections.map(section => {
      const button = element('button', 'song-section');
      button.style.flexGrow = section.end - section.start;
      button.addEventListener('click', () => onJump(section.start));
      return button;
    }));
    strip.dataset.song = song.id;
  }
  stats.sections.forEach((section, i) => {
    const button = strip.children[i];
    const here = ordinal >= section.start && ordinal < section.end;
    button.style.setProperty('--tone', tone(section.accuracy));
    button.classList.toggle('here', here);
    button.style.setProperty('--at', here ? `${100 * (ordinal - section.start) / (section.end - section.start)}%` : '0%');
    button.title = `${section.label} · ${section.accuracy === null ? 'not played yet' : `${section.accuracy}% first try`}`;
    button.setAttribute('aria-label', `Jump to ${button.title}`);
  });
  const accuracy = sessionAccuracy(progress);
  $('songAccuracy').querySelector('b').textContent = accuracy === null ? '—' : `${accuracy}%`;
  $('songStreak').querySelector('b').textContent = progress.streak;
  const wrong = progress.wrong.map(pitch => pitchName(pitch, song.key)).join(' + ');
  $('songWrong').textContent = wrong ? `✕ ${wrong}` : '';
  $('songWrong').hidden = !wrong;
}
