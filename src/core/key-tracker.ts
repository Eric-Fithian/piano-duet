import { musicalKey } from "./musical-key.ts";
import type { KeyMode } from "./musical-key.ts";
import { mean } from "./numeric.ts";

export type KeyNote = { pitch: number; duration: number; velocity: number };
const PROFILES: Record<KeyMode, number[]> = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};
const KEYS = (["major", "minor"] as const).flatMap((mode) => Array.from({ length: 12 }, (_, tonic) => musicalKey(tonic, mode)));
const NORMALIZED = KEYS.map((key) => {
  const profile = Array.from({ length: 12 }, (_, pitch) => PROFILES[key.mode][(pitch - key.tonic + 12) % 12]);
  const center = mean(profile), centered = profile.map((value) => value - center);
  const norm = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0));
  return centered.map((value) => value / norm);
});

export class KeyTracker {
  private current: number | null = null;

  observe(notes: KeyNote[]) {
    if (!notes.length) throw new Error("Key detection requires at least one played note");
    const histogram = Array<number>(12).fill(0);
    for (const note of notes) histogram[note.pitch % 12] += Math.sqrt(Math.min(note.duration, 1.5)) * (0.5 + note.velocity / 254);
    const total = histogram.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) throw new Error("Key detection requires positive note durations");
    const normalized = histogram.map((value) => value / total), center = mean(normalized);
    const centered = normalized.map((value) => value - center), norm = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0));
    const scores = KEYS.map((key, index) => {
      const correlation = norm > 1e-8 ? NORMALIZED[index].reduce((sum, value, pitch) => sum + value * centered[pitch], 0) / norm : 0;
      const coverage = key.pitch_classes.reduce((sum, pitch) => sum + normalized[pitch], 0);
      return 0.6 * correlation + 0.8 * coverage;
    });
    const chosen = scores.reduce((best, value, index) => value > scores[best] ? index : best, 0);
    const previous = this.current;
    this.current = chosen;
    const alternative = Math.max(...scores.filter((_, index) => index !== chosen));
    const changed = previous !== null && previous !== chosen;
    return { ...KEYS[chosen], tentative: notes.length < 6 || scores[chosen] - alternative < 0.08,
      changed, previous: changed ? KEYS[previous].name : null };
  }
}
