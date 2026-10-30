import type { RecordingInterval } from "./recording-intervals.ts";

export const RECORDING_RATE = 44100;
export const RECORDING_WINDOW = 4096;
export const RECORDING_HOP = 1024;
export const RECORDING_SEGMENT = 16 * RECORDING_RATE;
export const RECORDING_PAD = 8 * RECORDING_RATE;
export const RECORDING_STEP = Math.ceil(RECORDING_PAD / RECORDING_HOP) * RECORDING_HOP;
export const RECORDING_FRAMES = Math.ceil(RECORDING_SEGMENT / RECORDING_HOP) + 1;
export const RECORDING_TRACKS = 90;
export const RECORDING_CONTEXT = 256;
const LAST_FRAME = Math.round(RECORDING_SEGMENT / RECORDING_HOP);

export interface RecordingEvent { pitch: number; start: number; end: number; velocity: number; hasOnset: boolean; hasOffset: boolean }
export interface RecordingNote { pitch: number; start: number; duration: number; velocity: number }

export function recordingFrames(audio: Float32Array, segmentStart: number): Float32Array {
  if (!Number.isInteger(segmentStart) || segmentStart < 0) throw new Error("Invalid recording segment start");
  const frames = new Float32Array(RECORDING_FRAMES * RECORDING_WINDOW);
  for (let index = 0; index < RECORDING_FRAMES; index++) {
    const relative = index * RECORDING_HOP - RECORDING_WINDOW / 2;
    const from = Math.max(0, -relative, RECORDING_PAD - segmentStart - relative);
    const to = Math.min(RECORDING_WINDOW, RECORDING_SEGMENT - relative, audio.length + RECORDING_PAD - segmentStart - relative);
    if (to > from) frames.set(audio.subarray(segmentStart + relative + from - RECORDING_PAD,
      segmentStart + relative + to - RECORDING_PAD), index * RECORDING_WINDOW + from);
  }
  return frames;
}

export function intervalEndpoints(context: Float32Array, paths: RecordingInterval[][], frames: number): { start: Float32Array; end: Float32Array } {
  if (paths.length !== RECORDING_TRACKS || context.length !== paths.length * frames * RECORDING_CONTEXT) throw new Error("Invalid recording context");
  const count = paths.reduce((sum, track) => sum + track.length, 0);
  const start = new Float32Array(count * RECORDING_CONTEXT), end = new Float32Array(start.length);
  let index = 0;
  paths.forEach((track, pitch) => track.forEach(([begin, finish]) => {
    if (begin < 0 || finish < begin || finish >= frames) throw new Error("Invalid recording interval");
    const base = pitch * frames * RECORDING_CONTEXT;
    start.set(context.subarray(base + begin * RECORDING_CONTEXT, base + (begin + 1) * RECORDING_CONTEXT), index * RECORDING_CONTEXT);
    end.set(context.subarray(base + finish * RECORDING_CONTEXT, base + (finish + 1) * RECORDING_CONTEXT), index * RECORDING_CONTEXT);
    index++;
  }));
  return { start, end };
}

function timingOffset(logit: number): number {
  if (!Number.isFinite(logit)) throw new Error("Invalid recording timing");
  const mean = Math.abs(logit) < 0.04 ? 0.5 + logit / 12 - logit ** 3 / 720
    : 1 / -Math.expm1(-logit) - 1 / logit;
  return Math.max(-0.5, Math.min(0.5, (mean - 0.5) / 0.99));
}

export function recordingEvents(paths: RecordingInterval[][], velocity: Float32Array, timing: Float32Array,
  lastFrame = LAST_FRAME): { events: RecordingEvent[]; lastPositions: number[] } {
  const count = paths.reduce((sum, track) => sum + track.length, 0);
  if (paths.length !== RECORDING_TRACKS || velocity.length !== count * 128 || timing.length !== count * 4) {
    throw new Error("Invalid recording interval attributes");
  }
  const events: RecordingEvent[] = [], lastPositions: number[] = [];
  let index = 0;
  paths.forEach((track, symbol) => {
    let lastEnd = 0, lastPosition = 0;
    for (const [begin, end] of track) {
      let loudness = 0;
      for (let candidate = 0; candidate < 128; candidate++) {
        const value = velocity[index * 128 + candidate];
        if (!Number.isFinite(value)) throw new Error("Invalid recording velocity");
        if (value > velocity[index * 128 + loudness]) loudness = candidate;
      }
      const row = index * 4;
      const start = Math.max((begin + timingOffset(timing[row])) * RECORDING_HOP / RECORDING_RATE, lastEnd);
      const finish = Math.max((end + timingOffset(timing[row + 1])) * RECORDING_HOP / RECORDING_RATE, start + 1e-8);
      const hasOnset = begin > 0 || timing[row + 2] > 0;
      const hasOffset = end < lastFrame || timing[row + 3] > 0;
      if (!Number.isFinite(timing[row + 2]) || !Number.isFinite(timing[row + 3])) throw new Error("Invalid recording boundary");
      events.push({ start, end: finish, pitch: symbol === 0 ? -64 : symbol === 1 ? -67 : symbol + 19,
        velocity: loudness, hasOnset, hasOffset });
      lastEnd = finish;
      if (hasOffset) lastPosition = end;
      index++;
    }
    lastPositions.push(lastPosition);
  });
  events.sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
  return { events, lastPositions };
}

export class RecordingAssembler {
  private readonly duration: number;
  private readonly byPitch = new Map<number, RecordingEvent[]>();
  positions = Array.from({ length: RECORDING_TRACKS }, () => Math.floor(RECORDING_PAD / RECORDING_HOP));

  constructor(samples: number) {
    if (!Number.isSafeInteger(samples) || samples < 0) throw new Error("Invalid recording length");
    this.duration = samples / RECORDING_RATE;
  }

  accept(segmentStart: number, segment: ReturnType<typeof recordingEvents>): void {
    this.positions = segment.lastPositions.map((position) => Math.max(0, position - RECORDING_STEP / RECORDING_HOP));
    const shift = segmentStart / RECORDING_RATE - 8;
    for (const value of segment.events) {
      const start = Math.max(0, value.start + shift);
      const event = { ...value, start, end: Math.max(start, value.end + shift) };
      const items = this.byPitch.get(event.pitch) ?? [];
      const last = items.at(-1);
      if (last && event.start < last.end) {
        if (event.hasOnset) items[items.length - 1] = event;
        else { last.hasOffset = event.hasOffset; last.end = Math.max(last.end, event.end); }
      } else if (event.hasOnset) items.push(event);
      this.byPitch.set(event.pitch, items);
    }
  }

  finish(): RecordingNote[] {
    for (const track of this.byPitch.values()) if (track.length) track[track.length - 1].hasOffset = true;
    const events = [...this.byPitch.values()].flat().filter((event) => event.hasOffset)
      .sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
    const previous = new Map<number, RecordingEvent>();
    for (const event of events) {
      const prior = previous.get(event.pitch);
      if (prior && prior.end > event.start) prior.end = event.start;
      previous.set(event.pitch, event);
    }
    return events.filter((event) => event.pitch > 0 && Math.min(event.end, this.duration) > event.start)
      .map((event) => ({ pitch: event.pitch, start: event.start, duration: Math.min(event.end, this.duration) - event.start,
        velocity: Math.max(1, event.velocity) }))
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  }
}
