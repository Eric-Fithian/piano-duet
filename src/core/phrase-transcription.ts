import { roundDecimal, roundEven } from "./numeric.ts";
import type { ContextNote } from "./aria-tokenizer.ts";

export interface PhrasePrediction {
  onset: Float32Array;
  offset: Float32Array;
  frame: Float32Array;
  velocity: Float32Array;
  pedalOffset: Float32Array;
  pedalFrame: Float32Array;
  frames: number;
}

type Peaks = { active: Uint8Array; shift: Float32Array };
type Segment = { begin: number; end: number; beginShift: number; endShift: number; velocity: number };

export function decodePhrase(prediction: PhrasePrediction, threshold: number, audioSeconds: number): {
  notes: ContextNote[]; quality: { usable: boolean; onset_support: number | null; supported_fraction: number; note_support: number[]; reason: string };
} {
  const { frames, onset, offset, frame, velocity, pedalOffset, pedalFrame } = prediction;
  if (!Number.isInteger(frames) || frames < 1 || [onset, offset, frame, velocity].some((item) => item.length !== frames * 88)
      || pedalOffset.length !== frames || pedalFrame.length !== frames || !Number.isFinite(audioSeconds) || audioSeconds < 0
      || !Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.99) throw new Error("Invalid phrase transcription outputs");
  const attacks = peaks(onset, frames, 88, threshold, 2), releases = peaks(offset, frames, 88, 0.3, 4);
  const pedalReleases = peaks(pedalOffset, frames, 1, 0.2, 4);
  const pedals = pedalSegments(pedalFrame, pedalReleases).map((segment) => [
    Math.fround((segment.begin + segment.beginShift) / 100), Math.fround((segment.end + segment.endShift) / 100),
  ]);
  const found: { note: ContextNote; support: number }[] = [];
  for (let pitch = 0; pitch < 88; pitch++) {
    for (const segment of noteSegments(pitch, frames, frame, velocity, attacks, releases)) {
      const noteOn = Math.fround((segment.begin + segment.beginShift) / 100);
      let noteOff = Math.fround((segment.end + segment.endShift) / 100);
      for (const [start, end] of pedals) if (start < noteOff && noteOff < end) { noteOff = end; break; }
      const start = Math.max(0, Math.fround(noteOn - 0.25)), end = Math.min(audioSeconds, Math.fround(noteOff - 0.25));
      const duration = Math.fround(end - start);
      if (duration < 0.055 || start >= audioSeconds) continue;
      const center = roundEven(Math.fround(noteOn * 100));
      let strength = -Infinity;
      for (let index = Math.max(0, center - 3); index < Math.min(frames, center + 4); index++) strength = Math.max(strength, onset[index * 88 + pitch]);
      found.push({ note: { pitch: pitch + 21, start, duration, velocity: Math.max(1, Math.trunc(segment.velocity * 128)) }, support: strength });
    }
  }
  found.sort((a, b) => a.note.start - b.note.start || a.note.pitch - b.note.pitch);
  if (!found.length) return { notes: [], quality: { usable: false, onset_support: null, supported_fraction: 0,
    note_support: [], reason: "No recognized notes" } };
  const average = found.reduce((sum, item) => sum + item.support, 0) / found.length;
  const fraction = found.filter((item) => item.support >= 0.6).length / found.length;
  return { notes: found.map((item) => item.note), quality: { usable: average >= 0.75 && fraction >= 0.8,
    onset_support: roundDecimal(average, 3), supported_fraction: roundDecimal(fraction, 3),
    note_support: found.map((item) => roundDecimal(item.support, 3)),
    reason: "Onset model support; not a calibrated probability of correct transcription" } };
}

function peaks(values: Float32Array, frames: number, channels: number, threshold: number, neighbors: number): Peaks {
  const active = new Uint8Array(values.length), shift = new Float32Array(values.length);
  for (let channel = 0; channel < channels; channel++) {
    for (let time = neighbors; time < frames - neighbors; time++) {
      const index = time * channels + channel, center = values[index];
      if (!(center > threshold)) continue;
      let monotonic = true;
      for (let step = 0; step < neighbors; step++) {
        if (values[index - step * channels] < values[index - (step + 1) * channels]
            || values[index + step * channels] < values[index + (step + 1) * channels]) monotonic = false;
      }
      if (!monotonic) continue;
      const before = values[index - channels], after = values[index + channels];
      const denominator = Math.fround(center - (before > after ? after : before));
      if (denominator === 0) throw new Error("A transcription peak has no slope");
      active[index] = 1;
      shift[index] = Math.fround(Math.fround(Math.fround(after - before) / denominator) / 2);
    }
  }
  return { active, shift };
}

function noteSegments(pitch: number, frames: number, frame: Float32Array, velocity: Float32Array, attacks: Peaks, releases: Peaks): Segment[] {
  const result: Segment[] = [];
  let begin: number | null = null, disappear: number | null = null, offset: number | null = null;
  const push = (end: number, endShift: number) => {
    const index = begin! * 88 + pitch;
    result.push({ begin: begin!, end, beginShift: attacks.shift[index], endShift, velocity: velocity[index] });
  };
  for (let time = 0; time < frames; time++) {
    const index = time * 88 + pitch;
    if (attacks.active[index]) {
      if (begin !== null) { push(Math.max(time - 1, 0), 0); disappear = offset = null; }
      begin = time;
    }
    if (begin !== null && time > begin) {
      if (frame[index] <= 0.1 && disappear === null) disappear = time;
      if (releases.active[index] && offset === null) offset = time;
      if (disappear !== null) {
        const end = offset !== null && offset - begin > disappear - offset ? offset : disappear;
        push(end, releases.shift[end * 88 + pitch]);
        begin = disappear = offset = null;
      }
      if (begin !== null && (time - begin >= 600 || time === frames - 1)) {
        push(time, releases.shift[index]);
        begin = disappear = offset = null;
      }
    }
  }
  return result;
}

function pedalSegments(frame: Float32Array, releases: Peaks): Segment[] {
  const result: Segment[] = [];
  let begin: number | null = null, disappear: number | null = null, offset: number | null = null;
  const push = (end: number) => result.push({ begin: begin!, end, beginShift: 0, endShift: releases.shift[end], velocity: 0 });
  for (let time = 1; time < frame.length; time++) {
    if (frame[time] >= 0.5 && frame[time] > frame[time - 1] && begin === null) begin = time;
    if (begin !== null && time > begin) {
      if (frame[time] <= 0.5 && disappear === null) disappear = time;
      if (releases.active[time] && offset === null) offset = time;
      if (offset !== null) { push(offset); begin = disappear = offset = null; }
      if (disappear !== null && time - disappear >= 10) { push(disappear); begin = disappear = offset = null; }
    }
  }
  return result;
}
