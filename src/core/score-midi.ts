import { roundEven } from "./numeric.ts";

export class ScoreError extends Error {}
export type ImportedNote = { pitch: number; beat: number; length: number; velocity: number; staff: "bass" | "treble" };
export type MidiScore = { notes: ImportedNote[]; bpm: number; meters: [number, string][]; key: [number, string] | null;
  title: null; composer: null; pickup: number };

export function parseMidi(data: Uint8Array): MidiScore {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const need = (offset: number, size: number, end = data.length) => {
    if (offset < 0 || size < 0 || offset + size > end) throw new ScoreError("The MIDI file is truncated");
  };
  const text = (offset: number, size: number) => { need(offset, size); return String.fromCharCode(...data.subarray(offset, offset + size)); };
  if (data.length < 4 || text(0, 4) !== "MThd") throw new ScoreError("This is not a standard MIDI file");
  need(4, 10);
  const headerLength = view.getUint32(4), tracks = view.getUint16(10), division = view.getUint16(12);
  if (division & 0x8000) throw new ScoreError("SMPTE-timed MIDI files are not supported; export with beat timing");
  if (!division || headerLength < 6) throw new ScoreError("The MIDI file has an invalid header");
  let at = 8 + headerLength;
  const notes: (Omit<ImportedNote, "staff"> & { track: number })[] = [];
  const tempos: [number, number][] = [], meters: [number, string][] = [], keys: [number, number, string][] = [];
  for (let track = 0; track < tracks; track++) {
    need(at, 8);
    if (text(at, 4) !== "MTrk") throw new ScoreError("The MIDI file has a malformed track");
    const size = view.getUint32(at + 4), end = at + 8 + size;
    need(at + 8, size);
    at += 8;
    let tick = 0, status: number | null = null;
    const openNotes = new Map<number, [number, number][]>();
    const variableLength = () => {
      let value = 0;
      while (true) {
        need(at, 1, end);
        const byte = data[at++];
        value = value * 128 + (byte & 127);
        if (!Number.isSafeInteger(value)) throw new ScoreError("The MIDI file has an invalid variable-length value");
        if (!(byte & 128)) return value;
      }
    };
    while (at < end) {
      tick += variableLength();
      need(at, 1, end);
      if (data[at] === 0xff) {
        need(at, 2, end);
        const kind = data[at + 1]; at += 2;
        const sizeMeta = variableLength();
        need(at, sizeMeta, end);
        const body = data.subarray(at, at + sizeMeta); at += sizeMeta;
        if (kind === 0x51) {
          if (body.length !== 3) throw new ScoreError("The MIDI file has an invalid tempo");
          const micros = body[0] * 65536 + body[1] * 256 + body[2];
          if (!micros) throw new ScoreError("The MIDI file has an invalid tempo");
          tempos.push([tick, 60000000 / micros]);
        } else if (kind === 0x58) {
          if (body.length < 2) throw new ScoreError("The MIDI file has an invalid time signature");
          meters.push([tick / division, `${body[0]}/${2 ** body[1]}`]);
        } else if (kind === 0x59) {
          if (body.length < 2) throw new ScoreError("The MIDI file has an invalid key signature");
          keys.push([tick, body[0] < 128 ? body[0] : body[0] - 256, body[1] ? "minor" : "major"]);
        } else if (kind === 0x2f) break;
        continue;
      }
      if (data[at] === 0xf0 || data[at] === 0xf7) {
        at++;
        const sizeSysEx = variableLength();
        need(at, sizeSysEx, end); at += sizeSysEx;
        continue;
      }
      if (data[at] & 128) status = data[at++];
      if (status === null) throw new ScoreError("The MIDI file uses running status before any event");
      const kind = status & 0xf0, channel = status & 0x0f, width = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      need(at, width, end);
      const pitch = data[at], velocity = data[at + 1]; at += width;
      if (channel === 9) continue;
      if (kind === 0x90 && velocity > 0) {
        const pending = openNotes.get(pitch) ?? [];
        pending.push([tick, velocity]); openNotes.set(pitch, pending);
      } else if (kind === 0x80 || kind === 0x90 && velocity === 0) {
        const pending = openNotes.get(pitch);
        if (pending?.length) {
          const [start, loudness] = pending.shift()!;
          notes.push({ pitch, beat: start / division, length: (tick - start) / division, velocity: loudness, track });
        }
      }
    }
    at = end;
  }
  const byTrack = new Map<number, number[]>();
  for (const note of notes) {
    const pitches = byTrack.get(note.track) ?? [];
    pitches.push(note.pitch); byTrack.set(note.track, pitches);
  }
  const hands = [...byTrack].sort((a, b) => a[1].reduce((sum, pitch) => sum + pitch, 0) / a[1].length
    - b[1].reduce((sum, pitch) => sum + pitch, 0) / b[1].length).map(([track]) => track);
  const output = notes.map(({ track, ...note }): ImportedNote => ({ ...note, staff: hands.length === 2
    ? track === hands[0] ? "bass" : "treble" : note.pitch < 60 ? "bass" : "treble" }));
  tempos.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  meters.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  keys.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return { notes: output, bpm: tempos.length ? roundEven(tempos[0][1]) : 120, meters,
    key: keys.length ? [keys[0][1], keys[0][2]] : null, title: null, composer: null, pickup: 0 };
}
