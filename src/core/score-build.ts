import { KeyTracker, signatureMode } from "./key-tracker.ts";
import { musicalKey } from "./musical-key.ts";
import { roundDecimal, roundEven } from "./numeric.ts";
import { parseMidi, ScoreError } from "./score-midi.ts";
import { parseMxl } from "./score-mxl.ts";
import { parseMusicXml } from "./score-xml.ts";

export type ParsedScore = { notes: { pitch: number; beat: number; length: number; velocity: number; staff: string; voice?: number; grace?: boolean }[];
  bpm: number; meters: [number, string][]; key: [number, string | null] | null; title: string | null; composer: string | null;
  pickup: number; measures?: number[] };
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

export function performanceTempo(notes: { start: number }[], parsed: ParsedScore): number {
  if (notes.length < 8) throw new ScoreError("Too few piano notes were recognized to write a score");
  if (!parsed.notes.length) throw new ScoreError("The file contains no playable notes");
  const seconds = Math.max(...notes.map((note) => note.start)) - Math.min(...notes.map((note) => note.start));
  const beats = parsed.notes.map((note) => note.beat);
  return seconds > 0 ? roundEven(60 * (Math.max(...beats) - Math.min(...beats)) / seconds) : 72;
}

function barShift(measures: number[], bar: number): number {
  const phases = measures.map((start) => roundDecimal(((start % bar) + bar) % bar, 6)), counts = new Map<number, number>();
  for (const phase of phases) counts.set(phase, (counts.get(phase) ?? 0) + 1);
  const phase = [...counts].reduce((best, item) => item[1] > best[1] ? item : best)[0];
  return ((bar - phase) % bar + bar) % bar;
}

function transcriptionLayout(input: ParsedScore): { parsed: ParsedScore; meter: string; shift: number } {
  if (!input.measures?.length) throw new ScoreError("The written score has no measures");
  const meters = [...new Set(input.meters.map(([, meter]) => meter))];
  let written = meters[0] ?? "4/4";
  if (meters.length > 1) {
    const end = Math.max(...input.notes.map((note) => note.beat + note.length)), spans = new Map<string, number>();
    input.meters.forEach(([start, meter], index) => spans.set(meter, (spans.get(meter) ?? 0) + (input.meters[index + 1]?.[0] ?? end) - start));
    written = [...spans].reduce((best, entry) => entry[1] > best[1] ? entry : best)[0];
  }
  const length = (meter: string) => { const [numerator, denominator] = meter.split("/").map(Number); return numerator * 4 / denominator; };
  let meter = written;
  if (!METERS.includes(meter)) {
    const matches = METERS.filter((candidate) => length(candidate) === length(written)).sort((a, b) => Number(!a.endsWith("/4")) - Number(!b.endsWith("/4")));
    if (!matches.length) throw new ScoreError(`${written} time is not supported yet`);
    meter = matches[0];
  }
  const clamp = (bpm: number) => Math.min(240, Math.max(30, bpm));
  const starts = [...new Map(input.notes.map((note) => [`${note.staff}:${roundDecimal(note.beat, 6)}`, [note.staff, roundDecimal(note.beat, 6)] as const])).values()];
  const merged = (scale: number) => {
    const grids = gridsFor(starts.map(([, beat]) => beat * scale * TICKS), meter.endsWith("/8"));
    const rounded = new Set(starts.map(([staff, beat]) => `${staff}:${snap(beat * scale * TICKS, grids)}`));
    return (starts.length - rounded.size) / starts.length;
  };
  const scales = [1, 2, 0.5, 4, 0.25].filter((scale) => Math.abs(clamp(input.bpm * scale) / (input.bpm * scale) - 1) <= 0.05);
  if (!scales.length) throw new ScoreError(`A tempo of ${input.bpm} bpm cannot be written in any note values`);
  const scale = scales.find((value) => merged(value) <= 0.02) ?? scales.reduce((best, value) => merged(value) < merged(best) ? value : best);
  const parsed = { ...input, bpm: roundEven(clamp(input.bpm * scale)), measures: input.measures.map((start) => start * scale),
    meters: input.meters.map(([start, value]) => [start * scale, value] as [number, string]),
    notes: input.notes.map((note) => ({ ...note, beat: note.beat * scale, length: note.length * scale })) };
  if (meter === "3/4" || meter === "12/8") {
    const bar = length(meter), shift = barShift(parsed.measures, bar);
    let compound = 0, simple = 0;
    for (const note of parsed.notes) {
      if (note.grace) continue;
      const position = ((note.beat + shift) % bar + bar) % bar;
      const onQuarter = Math.abs(position - Math.round(position)) < 1e-7;
      const onDotted = Math.abs(position / 1.5 - Math.round(position / 1.5)) < 1e-7;
      if (onDotted && !onQuarter) compound++;
      if (onQuarter && !onDotted) simple++;
    }
    meter = meter === "3/4" ? (compound > simple ? "6/8" : "3/4") : (compound > simple ? "12/8" : "3/4");
  }
  return { parsed, meter, shift: barShift(parsed.measures, length(meter)) };
}

export function buildSong(input: ParsedScore, title: string | null, artist: string | null, filename: string, transcribed = false) {
  let parsed = input;
  if (!parsed.notes.length) throw new ScoreError("The file contains no playable notes");
  const meters = [...new Set(parsed.meters.map(([, meter]) => meter))].sort();
  if (meters.length > 1 && !transcribed) throw new ScoreError(`This score changes time signature (${meters.join(", ")}); only one meter is supported`);
  const layout = transcribed ? transcriptionLayout(parsed) : null;
  if (layout) parsed = layout.parsed;
  const meter = layout?.meter ?? meters[0] ?? "4/4";
  if (!METERS.includes(meter)) throw new ScoreError(`${meter} time is not supported yet`);
  const [numerator, denominator] = meter.split("/").map(Number), bar = numerator * 4 / denominator;
  const shift = layout?.shift ?? (parsed.pickup ? ((bar - parsed.pickup) % bar + bar) % bar : 0), bpm = parsed.bpm;
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
