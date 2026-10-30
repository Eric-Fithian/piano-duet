import type { MusicalKey } from "./musical-key.ts";

const NATURAL: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function staffStep(pitch: number, key: MusicalKey): number {
  const name = key.scale_names[key.pitch_classes.indexOf(pitch % 12)];
  if (!name) throw new Error(`Pitch ${pitch} is not in ${key.name}`);
  const letter = name[0];
  const alteration = [...name].filter((character) => character === "#").length - [...name].filter((character) => character === "b").length;
  const octave = Math.floor((pitch - NATURAL[letter] - alteration) / 12);
  return octave * 7 + "CDEFGAB".indexOf(letter) - 12;
}

export function readingAttacks(target: { start: number }[]): { start: number; indices: number[] }[] {
  const groups: { start: number; indices: number[] }[] = [];
  target.forEach(({ start }, index) => {
    if (!groups.length || groups[groups.length - 1].start !== start) groups.push({ start, indices: [] });
    groups[groups.length - 1].indices.push(index);
  });
  return groups;
}
