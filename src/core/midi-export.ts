import { roundEven } from "./numeric.ts";
import type { PracticeNote } from "./practice-assessment.ts";

export function exportMidi(notes: PracticeNote[]): Uint8Array {
  if (!notes.length) throw new Error("Cannot export an empty performance");
  const byPitch = new Map<number, { pitch: number; start: number; end: number; velocity: number }[]>();
  for (const note of notes) {
    if (!Number.isInteger(note.pitch) || note.pitch < 21 || note.pitch > 108 || !Number.isFinite(note.start) || note.start < 0
      || !Number.isFinite(note.duration) || note.duration <= 0 || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) {
      throw new Error("Invalid MIDI note");
    }
    const group = byPitch.get(note.pitch) ?? [];
    group.push({ pitch: note.pitch, start: roundEven(note.start * 1000), end: roundEven((note.start + note.duration) * 1000), velocity: note.velocity });
    byPitch.set(note.pitch, group);
  }
  const normalized: { pitch: number; start: number; end: number; velocity: number }[] = [];
  for (const group of byPitch.values()) {
    group.sort((a, b) => a.start - b.start || a.end - b.end);
    const distinct: typeof group = [];
    for (const note of group) {
      const previous = distinct.at(-1);
      if (previous?.start === note.start) {
        if (note.end > previous.end) { previous.end = note.end; previous.velocity = note.velocity; }
        else if (note.end === previous.end) previous.velocity = Math.max(previous.velocity, note.velocity);
      } else distinct.push(note);
    }
    for (let index = 1; index < distinct.length; index++) {
      if (distinct[index - 1].end > distinct[index].start) distinct[index - 1].end = distinct[index].start;
    }
    normalized.push(...distinct.filter((note) => note.end > note.start));
  }
  normalized.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const events = normalized.flatMap((note, index) => [{ tick: note.start, pitch: note.pitch, velocity: note.velocity, index },
    { tick: note.end, pitch: note.pitch, velocity: 0, index }]);
  events.sort((a, b) => a.tick - b.tick || a.velocity - b.velocity || a.index - b.index);
  const track = [0, 0xff, 0x51, 3, 7, 0xa1, 0x20, 0, 0xc0, 0];
  let previous = 0;
  for (const event of events) {
    track.push(...variableLength(event.tick - previous), 0x90, event.pitch, event.velocity);
    previous = event.tick;
  }
  track.push(0, 0xff, 0x2f, 0);
  const length = track.length;
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xf4,
    0x4d, 0x54, 0x72, 0x6b, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...track]);
}

function variableLength(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff) throw new Error("MIDI event time is out of range");
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 127) | 128);
  return bytes;
}
