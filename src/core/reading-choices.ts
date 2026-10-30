import { movementNeed, pitchNeed } from "./reading-line.ts";
import type { ReadingHand, ReadingLine } from "./reading-line.ts";
import type { MusicalKey } from "./musical-key.ts";

const EPSILON = 1e-9;

export function degree(scale: number[], pitch: number): number {
  for (const candidate of [pitch, pitch - 1, pitch + 1]) {
    const index = scale.indexOf(candidate);
    if (index >= 0) return index;
  }
  throw new Error(`Pitch ${pitch} has no neighboring scale degree`);
}

function consistent(line: ReadingLine): number[][] {
  return line.rhythms.filter((rhythm) => rhythm.length >= line.prefix.length + 1
    && line.prefix.every((value, index) => rhythm[index] === value));
}

export function remainingAttacks(line: ReadingLine): number {
  const depths = consistent(line).map((rhythm) => rhythm.slice(line.prefix.length + 1).filter((value) => value > 0).length);
  if (!depths.length) throw new Error("No rhythm matches the current prefix");
  return Math.min(...depths);
}

export function remainingBeats(line: ReadingLine): number {
  const counts = consistent(line).map((rhythm) => {
    let position = line.cursor + Math.abs(rhythm[line.prefix.length]);
    let count = 0;
    for (const value of rhythm.slice(line.prefix.length + 1)) {
      if (value > 0 && line.starts.slice(0, -1).some((start) => Math.abs(position - start) < EPSILON)) count++;
      position += Math.abs(value);
    }
    return count;
  });
  if (!counts.length) throw new Error("No rhythm matches the current prefix");
  return Math.min(...counts);
}

export function introducing(step: number, pool: number[], scale: number[], previous: number | null, choices: number[], remaining: number): number[] {
  const exact = choices.filter((pitch) => previous !== null && Math.abs(degree(scale, pitch) - degree(scale, previous)) === step);
  if (!remaining) return exact;
  const reachable = choices.filter((pitch) => pool.some((other) => Math.abs(degree(scale, other) - degree(scale, pitch)) === step));
  return [...new Set([...exact, ...reachable])].sort((a, b) => a - b);
}

export function noteWeight(hand: ReadingHand, previous: number, pitch: number): number {
  return pitchNeed(hand, pitch) * movementNeed(hand, previous, pitch) * (pitch === previous ? 0.3 : 1);
}

export function chromaticOptions(stage: { chromatic: number }, key: MusicalKey, line: ReadingLine,
  lowest: Map<number, number>, hand: ReadingHand, previous: number): Map<number, number> {
  if (!stage.chromatic) return new Map();
  const subtonic = (key.tonic + 10) % 12;
  const options = new Set<number>();
  if (key.mode === "minor" && (stage.chromatic === 1 || line.accidental && !line.altered)) {
    for (const pitch of lowest.keys()) if (pitch % 12 === subtonic) options.add(pitch + 1);
  }
  if (stage.chromatic >= 2 && line.accidental && !line.altered) {
    for (const pitch of lowest.keys()) for (const step of [-1, 1]) {
      const next = pitch + step;
      if (!key.pitch_classes.includes(next % 12) && line.pool[0] <= next && next <= line.pool.at(-1)!) options.add(next);
    }
  }
  return new Map([...options].sort((a, b) => a - b).map((pitch) => [pitch, noteWeight(hand, previous, pitch)]));
}
