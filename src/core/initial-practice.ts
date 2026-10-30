import { musicalKey } from "./musical-key.ts";
import { pitchName } from "./reading-assessment.ts";

export function initialPracticeTask(id: string, focus: "guided" | "technique") {
  const key = musicalKey(0, "major");
  const ascending = [60, 62, 64, 65, 67, 69, 71, 72];
  const pitches = [...ascending, ...ascending.slice(0, -1).reverse()];
  const reason = focus === "guided" ? "A comfortable scale gives us a first look at your playing."
    : "Practice the focus you selected.";
  return {
    id, family: "technique" as const, challenge: 1, bpm: 50, meter: "4/4", key,
    reason: `${reason} Explore C major, which has less practice in this skill.`, purpose: "Explore",
    context: { notation_visible: true, hearings: 0, reveals: 0, hints: 0, familiar: false },
    target: pitches.map((pitch, index) => ({ pitch, start: index * 60 / 50, duration: 60 / 50, velocity: 76 })),
    title: "C major scale",
    instruction: "Play the C major scale up and back down, starting on C4. Use one hand. Aim for an even sound and one note per beat at 50 BPM. Start slower if you need to.",
    lesson: "A major scale steps whole, whole, half, whole, whole, whole, half; natural minor steps whole, half, whole, whole, half, whole, whole. A half step is the next key, including black keys.",
    shape: "scale", cue: pitches.map((pitch) => pitchName(pitch, key)).join(" → "), even: true, dynamics: "even",
  };
}
