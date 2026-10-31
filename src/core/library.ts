import { musicalKey } from "./musical-key.ts";
import type { KeyMode, MusicalKey } from "./musical-key.ts";
import { mean, roundDecimal, roundEven } from "./numeric.ts";

export type SongNote = { pitch: number; start: number; duration: number; velocity: number; staff: string; voice?: number; grace?: boolean };
type SongOriginal = { bpm: number; meter: string; key: MusicalKey; bars: number; notes: SongNote[] };
export type Song = SongOriginal & { id: string; title: string; artist: string | null; source: string; created_at: number; original?: SongOriginal };
export type SongPlay = { created_at: number; attacks: [number, boolean][]; version: string };
const METERS = ["2/4", "3/4", "4/4", "5/4", "3/8", "6/8", "7/8", "9/8", "12/8"];

export function songAttacks(notes: SongNote[]): number[][] {
  const attacks: number[][] = [];
  for (const [index, note] of notes.entries()) {
    const last = attacks.at(-1);
    if (last && Math.abs(notes[last[0]].start - note.start) < 1e-9) last.push(index);
    else attacks.push([index]);
  }
  return attacks;
}

export function songSections(song: Song) {
  const [numerator, denominator] = song.meter.split("/").map(Number);
  const barSeconds = numerator * 4 / denominator * 60 / song.bpm, size = song.bars <= 16 ? 4 : 8;
  const attacks = songAttacks(song.notes), sections: { number: number; label: string; first_bar: number; start: number; end: number }[] = [];
  for (let first = 0; first < song.bars; first += size) {
    const last = Math.min(song.bars, first + size);
    const inside = attacks.flatMap((attack, index) => first * barSeconds - 1e-9 <= song.notes[attack[0]].start
      && song.notes[attack[0]].start < last * barSeconds - 1e-9 ? [index] : []);
    if (inside.length) sections.push({ number: sections.length + 1, label: `Bars ${first + 1}–${last}`, first_bar: first + 1,
      start: inside[0], end: inside.at(-1)! + 1 });
  }
  return sections;
}

export async function songVersion(notes: SongNote[]): Promise<string> {
  const shape = songAttacks(notes).map((attack) => attack.map((index) => notes[index].pitch).sort((a, b) => a - b));
  const canonical = JSON.stringify(shape).split(",").join(", ");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function editSong(song: Song, bpm: number, meter: string, tonic: number, mode: KeyMode, source: SongNote[]): Song {
  if (!METERS.includes(meter)) throw new Error(`${meter} time is not supported`);
  if (!source.length) throw new Error("A song needs at least one note");
  const notes = [...source].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  for (const note of notes) for (const edge of [note.start, note.start + note.duration]) {
    const tick = edge * bpm / 60 * 12;
    if (Math.abs(tick - roundEven(tick)) > 1e-3) throw new Error("Every note must start and end on the score's sixteenth or triplet grid");
  }
  const [numerator, denominator] = meter.split("/").map(Number);
  const beats = notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0) * bpm / 60;
  return { ...song, bpm, meter, key: musicalKey(tonic, mode), notes, bars: Math.max(1, Math.ceil(roundDecimal(beats, 6) / (numerator * 4 / denominator))),
    original: song.original ?? { bpm: song.bpm, meter: song.meter, key: song.key, bars: song.bars, notes: song.notes } };
}

export function revertSong(song: Song): Song {
  if (!song.original) throw new Error("This song has not been edited");
  const { original, ...current } = song;
  return { ...current, ...original };
}

function accuracy(rows: [number, boolean][]): number | null {
  return rows.length ? roundEven(100 * mean(rows.map(([, first]) => Number(first)))) : null;
}

export async function songStats(song: Song, allPlays: SongPlay[]) {
  const version = await songVersion(song.notes), plays = allPlays.filter((play) => play.version === version);
  const total = songAttacks(song.notes).length;
  if (!total) throw new Error("A song needs at least one attack");
  const perPlay = plays.map((play) => play.attacks).filter((attacks) => attacks.length);
  const recent = perPlay.slice(-5).flat(), best = perPlay.filter((attacks) => attacks.length >= Math.min(16, total)).map(accuracy) as number[];
  const sections = songSections(song).map((section) => {
    const touching = perPlay.map((attacks) => attacks.filter(([index]) => section.start <= index && index < section.end))
      .filter((rows) => rows.length).slice(-3);
    return { ...section, accuracy: accuracy(touching.flat()), plays: touching.length };
  });
  return { plays: perPlay.length, accuracy: accuracy(recent), best: best.length ? Math.max(...best) : null,
    coverage: roundEven(100 * new Set(perPlay.flat().map(([index]) => index)).size / total),
    last_played: plays.at(-1)?.created_at ?? null, sections, attacks: total };
}

export async function songSummary(song: Song, plays: SongPlay[]) {
  const stats = await songStats(song, plays);
  const seconds = song.notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0);
  return { id: song.id, title: song.title, artist: song.artist, bars: song.bars, seconds: roundEven(seconds), bpm: song.bpm,
    key: song.key.name, meter: song.meter, created_at: song.created_at, plays: stats.plays, accuracy: stats.accuracy,
    best: stats.best, coverage: stats.coverage, last_played: stats.last_played };
}
