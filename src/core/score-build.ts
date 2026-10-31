import { KeyTracker, signatureMode } from "./key-tracker.ts";
import { musicalKey } from "./musical-key.ts";
import { roundDecimal } from "./numeric.ts";
import { parseMidi, ScoreError } from "./score-midi.ts";
import { parseMxl } from "./score-mxl.ts";
import { parseMusicXml } from "./score-xml.ts";

export type ParsedScore = { notes: { pitch: number; beat: number; length: number; velocity: number; staff: string; voice?: number; grace?: boolean }[];
  bpm: number; meters: [number, string][]; key: [number, string | null] | null; title: string | null; composer: string | null; pickup: number };
const METERS = ["2/4", "3/4", "4/4", "5/4", "3/8", "6/8", "7/8", "9/8", "12/8"];
const TICKS = 12, SIXTEENTHS = [0, 3, 6, 9, 12], TRIPLETS = [0, 4, 8, 12];

export function parseScore(filename: string, data: Uint8Array): ParsedScore {
  const name = filename.toLowerCase();
  if (name.endsWith(".mid") || name.endsWith(".midi")) return parseMidi(data);
  if (name.endsWith(".musicxml") || name.endsWith(".xml")) return parseMusicXml(data);
  if (name.endsWith(".mxl")) return parseMxl(data);
  throw new ScoreError("Import a MIDI (.mid) or MusicXML (.musicxml, .xml, .mxl) file");
}

function gridsFor(ticks: number[], compound: boolean): Map<number, number[]> {
  const positions = new Map<number, number[]>();
  for (const tick of ticks) {
    const beat = Math.floor(tick / TICKS), values = positions.get(beat) ?? [];
    values.push(tick - beat * TICKS); positions.set(beat, values);
  }
  return new Map([...positions].map(([beat, values]) => {
    const error = (grid: number[]) => values.reduce((sum, value) => sum + Math.min(...grid.map((mark) => Math.abs(value - mark))), 0);
    return [beat, !compound && error(TRIPLETS) < error(SIXTEENTHS) ? TRIPLETS : SIXTEENTHS];
  }));
}

function snap(tick: number, grids: Map<number, number[]>): number {
  const beat = Math.floor(tick / TICKS), position = tick - beat * TICKS, grid = grids.get(beat) ?? SIXTEENTHS;
  const nearest = grid.reduce((best, mark) => Math.abs(position - mark) < Math.abs(position - best) ? mark : best);
  return beat * TICKS + nearest;
}

function step(tick: number, grids: Map<number, number[]>): number {
  const beat = Math.floor(tick / TICKS), position = tick - beat * TICKS, grid = grids.get(beat) ?? SIXTEENTHS;
  const next = grid.find((mark) => mark > position);
  if (next === undefined) throw new ScoreError("A score note cannot be placed on the grid");
  return next - position;
}

export function buildSong(parsed: ParsedScore, title: string | null, artist: string | null, filename: string) {
  if (!parsed.notes.length) throw new ScoreError("The file contains no playable notes");
  const meters = [...new Set(parsed.meters.map(([, meter]) => meter))].sort();
  if (meters.length > 1) throw new ScoreError(`This score changes time signature (${meters.join(", ")}); only one meter is supported`);
  const meter = meters[0] ?? "4/4";
  if (!METERS.includes(meter)) throw new ScoreError(`${meter} time is not supported yet`);
  const [numerator, denominator] = meter.split("/").map(Number), bar = numerator * 4 / denominator;
  const shift = parsed.pickup ? ((bar - parsed.pickup) % bar + bar) % bar : 0, bpm = parsed.bpm;
  if (!(bpm > 0) || !Number.isFinite(bpm)) throw new ScoreError("The score has an invalid tempo");
  const playable = parsed.notes.filter((note) => note.pitch >= 21 && note.pitch <= 108).sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  if (!playable.length) throw new ScoreError("The file contains no playable piano notes");
  const starts = playable.map((note) => (note.beat + shift) * TICKS);
  const grids = gridsFor(starts.filter((_, index) => !playable[index].grace), denominator === 8);
  const notes = playable.map((note, index) => {
    const raw = starts[index], tick = snap(raw, grids), end = Math.max(tick + step(tick, grids), snap(raw + note.length * TICKS, grids));
    return { pitch: note.pitch, start: tick / TICKS * 60 / bpm, duration: (end - tick) / TICKS * 60 / bpm,
      velocity: note.velocity, staff: note.staff, voice: note.voice ?? 0, ...(note.grace ? { grace: true } : {}) };
  });
  let key;
  if (parsed.key) {
    const [fifths, written] = parsed.key, mode = written ?? signatureMode(fifths, notes);
    const tonic = ((fifths * 7 + (mode === "minor" ? 9 : 0)) % 12 + 12) % 12;
    key = musicalKey(tonic, mode === "minor" ? "minor" : "major");
  } else key = new KeyTracker().observe(notes);
  const beats = notes.reduce((maximum, note) => Math.max(maximum, note.start + note.duration), 0) * bpm / 60;
  const dot = filename.lastIndexOf(".");
  return { title: title || parsed.title || (dot < 0 ? filename : filename.slice(0, dot)), artist: artist || parsed.composer,
    source: filename, bpm, meter, key, bars: Math.max(1, Math.ceil(roundDecimal(beats, 6) / bar)), notes };
}
