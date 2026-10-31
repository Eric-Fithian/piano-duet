export interface PhraseWriter {
  note(onset: number, pitches: Map<number, number>, durations: Map<number, number>): Promise<[number, number]> | [number, number];
  chordChance(pitches: number[]): Promise<number> | number;
}
export interface ChordRandom { random(): number }
const CHORD_BIAS: Record<string, number> = { dyads: 14, triads: 9, independent: 9, voicings: 9 };

export async function buildChord(texture: string, scale: number[], pitch: number, onset: number, seconds: number,
  shapes: number[][], forced: boolean, phrase: PhraseWriter, rng: ChordRandom): Promise<number[]> {
  const chord = [pitch];
  if (!shapes.length || !scale.includes(pitch)) return chord;
  const base = scale.indexOf(pitch);
  shapes = shapes.filter((shape) => base + Math.max(...shape) < scale.length && scale[base + Math.max(...shape)] - pitch <= 12);
  const bias = CHORD_BIAS[texture];
  if (bias === undefined) throw new Error(`Unknown chord texture ${texture}`);
  while (true) {
    const offsets = chord.map((note) => scale.indexOf(note) - base);
    const longer = shapes.filter((shape) => shape.length > offsets.length && offsets.every((offset, index) => shape[index] === offset));
    if (!longer.length) return chord;
    const following = [...new Set(longer.map((shape) => scale[base + shape[offsets.length]]))].sort((a, b) => a - b);
    const complete = shapes.some((shape) => shape.length === offsets.length && shape.every((value, index) => value === offsets[index]))
      || offsets.length === 1 && !forced;
    if (complete) {
      const chance = await phrase.chordChance(following) * bias;
      if (rng.random() >= chance / (chance + 1 - chance / bias)) return chord;
    }
    const [chosen] = await phrase.note(onset, new Map(following.map((value) => [value, 1])), new Map([[seconds, 1]]));
    chord.push(chosen);
  }
}
