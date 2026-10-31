import { roundEven } from "./numeric.ts";
import type { PracticeNote } from "./practice-assessment.ts";

export function exportMidi(notes: PracticeNote[]): Uint8Array {
  if (!notes.length) throw new Error("Cannot export an empty performance");
  const events = notes.flatMap((note, index) => {
    if (!Number.isInteger(note.pitch) || note.pitch < 21 || note.pitch > 108 || !Number.isFinite(note.start) || note.start < 0
      || !Number.isFinite(note.duration) || note.duration <= 0 || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) {
      throw new Error("Invalid MIDI note");
    }
    return [{ tick: roundEven(note.start * 1000), pitch: note.pitch, velocity: note.velocity, index, off: false },
      { tick: roundEven((note.start + note.duration) * 1000), pitch: note.pitch, velocity: 0, index, off: true }];
  });
  events.sort((a, b) => a.tick - b.tick || Number(b.off) - Number(a.off) || a.pitch - b.pitch || a.index - b.index);
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
