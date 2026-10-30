export type KeyMode = "major" | "minor";
export interface MusicalKey {
  name: string;
  tonic: number;
  mode: KeyMode;
  signature: string;
  pitch_classes: number[];
  scale_names: string[];
}

const INTERVALS: Record<KeyMode, number[]> = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const TONICS: Record<KeyMode, string[]> = {
  major: ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"],
  minor: ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"],
};
const LETTERS = "CDEFGAB";
const NATURALS = [0, 2, 4, 5, 7, 9, 11];

export function musicalKey(tonic: number, mode: KeyMode): MusicalKey {
  const spelling = TONICS[mode][tonic];
  if (spelling === undefined) throw new Error(`Invalid key tonic ${tonic}`);
  const first = LETTERS.indexOf(spelling[0]);
  const pitchClasses = INTERVALS[mode].map((interval) => (tonic + interval) % 12);
  const scaleNames = pitchClasses.map((pitch, index) => {
    const letter = (first + index) % 7;
    const alteration = (pitch - NATURALS[letter] + 6 + 12) % 12 - 6;
    return LETTERS[letter] + (alteration > 0 ? "#".repeat(alteration) : "b".repeat(-alteration));
  });
  return {
    name: `${spelling.replaceAll("b", "♭").replaceAll("#", "♯")} ${mode}`,
    tonic, mode, signature: spelling + (mode === "minor" ? "m" : ""),
    pitch_classes: pitchClasses, scale_names: scaleNames,
  };
}
