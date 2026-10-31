import type { DrillConfig } from "./drill-assessment.ts";
import { DRILL_CATALOG } from "./drill-catalog.ts";
import { DRILL_TIPS } from "./drill-pattern-data.ts";
import { drillPattern, register } from "./drill-patterns.ts";
import type { DrillPattern } from "./drill-patterns.ts";
import { drillMilestone } from "./drill-progress.ts";
import { pitchName } from "./drill-timing.ts";
import { musicalKey } from "./musical-key.ts";
import type { MusicalKey } from "./musical-key.ts";
import { roundDecimal, roundEven } from "./numeric.ts";

export type DrillSelection = DrillConfig & { practice: string };
export type DrillStanding = { working: number; best: number | null; streak: number };
const HANDS: Record<string, string> = DRILL_CATALOG.hands;
const PRACTICES: Record<string, string> = DRILL_CATALOG.practices;
const SUBDIVISIONS: Record<number, string> = DRILL_CATALOG.subdivisions;

export function validateDrill(config: DrillSelection) {
  const spec = DRILL_CATALOG.drills[config.drill];
  if (!spec) throw new Error("Unknown drill");
  if (!(spec.variants as readonly string[]).includes(config.variant)) throw new Error(`${spec.name} has no ${config.variant} form`);
  if (!Number.isInteger(config.tonic) || config.tonic < 0 || config.tonic >= 12) throw new Error("The tonic must be a pitch class from 0 to 11");
  if (!(spec.hands as readonly string[]).includes(config.hands)) throw new Error(`${spec.name} is not drilled ${HANDS[config.hands]?.toLowerCase() ?? config.hands}`);
  if (!(spec.octaves as readonly number[]).includes(config.octaves)) throw new Error(`${spec.name} does not span ${config.octaves} octaves`);
  if (!Number.isInteger(config.inversion) || config.inversion < 0 || config.inversion >= Math.max(1, spec.inversions)) throw new Error(`${spec.name} has no such starting position`);
  if (config.hands === "contrary" && config.variant === "melodic minor") throw new Error("Melodic minor differs going up and down, so it is not played in contrary motion");
  if (config.hands === "contrary" && config.octaves > 2) throw new Error("Contrary motion spans at most two octaves, as in the ABRSM syllabus");
  if (!(spec.practices as readonly string[]).includes(config.practice)) throw new Error(`${spec.name} is not practised with ${PRACTICES[config.practice]?.toLowerCase() ?? config.practice}`);
}

function staff(pitch: number, hand: string): string {
  return hand === "right" ? pitch >= 50 ? "treble" : "bass" : pitch <= 71 ? "bass" : "treble";
}

function render(events: DrillPattern, bpm: number, perBeat: number, practice: string) {
  const accent = practice === "accent-3" ? 3 : practice === "accent-4" ? 4 : null;
  const dotted = practice === "long-short" ? [1.5, 0.5] : practice === "short-long" ? [0.5, 1.5] : null;
  const starts = [0];
  for (let step = 0; step < events.length - 1; step++) starts.push(starts.at(-1)! + (dotted ? dotted[step % 2] : 1));
  const bar = 4 * perBeat, ends = [...starts.slice(1), Math.ceil((starts.at(-1)! + 1) / bar) * bar];
  return events.flatMap((event, step) => event.map(([pitch, hand, finger]) => {
    const accented = accent !== null && step % accent === 0;
    return { pitch, start: roundDecimal(starts[step] / perBeat * 60 / bpm, 6),
      duration: roundDecimal((ends[step] - starts[step]) / perBeat * 60 / bpm, 6),
      velocity: accent === null ? 76 : accented ? 100 : 60, hand, staff: staff(pitch, hand), step,
      ...(finger ? { finger } : {}), ...(accented ? { accent: true } : {}) };
  }));
}

function title(config: DrillSelection, key: MusicalKey): string {
  const tonic = key.name.split(" ")[0], variant = config.variant, spec = DRILL_CATALOG.drills[config.drill];
  const names = { five_finger: `${tonic} ${variant.replace("natural ", "")} five-finger pattern`, scale: `${tonic} ${variant} scale`,
    chromatic: `Chromatic scale from ${DRILL_CATALOG.tonics.major[config.tonic].replaceAll("b", "♭")}`,
    arpeggio: `${key.name} arpeggio`, seventh_arpeggio: variant === "dominant 7th" ? `Dominant 7th of ${key.name}` : `Diminished 7th on ${tonic}`,
    broken_chord: `${key.name} broken chord`, block_chord: `${key.name} chord inversions`, cadence: `${key.name} cadence`, hanon: `Hanon No. 1 in ${key.name}` };
  return names[config.drill] + (spec.inversions && config.inversion ? ` · ${DRILL_CATALOG.inversions[config.inversion].toLowerCase()}` : "");
}

function instruction(config: DrillSelection, key: MusicalKey, perBeat: number, bpm: number): string {
  const span = `${config.octaves} octave${config.octaves > 1 ? "s" : ""} up and back down`;
  const tonic = pitchName(register(config.tonic, config.octaves, config.hands), key);
  const how: Record<string, string> = { right: "with the right hand", left: "with the left hand", together: "hands together, an octave apart",
    contrary: `in contrary motion, both thumbs starting on ${tonic}`, third: "hands together a third apart, the right hand starting on the third (a tenth above)",
    sixth: "hands together a sixth apart, the left hand starting on the third below" };
  const shape = { five_finger: "Play five notes up and back", scale: `Play ${span}`, chromatic: `Play every semitone, ${span}`,
    arpeggio: `Play ${span}`, seventh_arpeggio: `Play ${span}`,
    broken_chord: "Break the triad up through each inversion to the octave, then back down through the same positions",
    block_chord: "Play the chord solid in each inversion, up an octave and back",
    cadence: "Play I, IV, V⁷ and I: bass roots in the left hand, chords in the right", hanon: `Climb the eight-note figure ${span}` };
  const text = config.drill === "cadence" ? `${shape.cadence}, in ${SUBDIVISIONS[perBeat]} at ♩ = ${bpm}.`
    : `${shape[config.drill]}, ${how[config.hands]}, in ${SUBDIVISIONS[perBeat]} at ♩ = ${bpm}.`;
  if (config.practice === "even") return text + " Every note the same length and loudness.";
  if (["long-short", "short-long"].includes(config.practice)) return text + ` Play each pair ${config.practice === "long-short" ? "long–short" : "short–long"}, a dotted rhythm. Only even playing moves your tempo.`;
  return text + ` Accent the first of every ${config.practice.at(-1)} notes and keep the others light. Only even playing moves your tempo.`;
}

export function buildDrillTask(config: DrillSelection, rung: number, progress: DrillStanding | null = null, id: string = crypto.randomUUID()) {
  validateDrill(config);
  const spec = DRILL_CATALOG.drills[config.drill], rungs = spec.ladder;
  if (!Number.isInteger(rung) || rung < 0 || rung >= rungs.length) throw new Error("That tempo is outside this drill's ladder");
  const tempo = rungs[rung], bpm = tempo.bpm;
  const perBeat = ["long-short", "short-long"].includes(config.practice) && tempo.per_beat > 2 ? 2 : tempo.per_beat;
  const mode = config.drill === "seventh_arpeggio" ? config.variant === "dominant 7th" ? "major" : "minor" : config.variant.includes("minor") ? "minor" : "major";
  const key = musicalKey(config.tonic, mode), target = render(drillPattern(config), bpm, perBeat, config.practice);
  const fits = [0, -12, 12].filter((shift) => target.every((note) => note.pitch + shift >= 21 && note.pitch + shift <= 108));
  if (!fits.length) throw new Error("This drill does not fit on the piano keyboard");
  const wrongStaff = (shift: number) => target.filter((note) => staff(note.pitch + shift, note.hand) !== (note.hand === "right" ? "treble" : "bass")).length;
  const shift = fits.reduce((best, candidate) => wrongStaff(candidate) < wrongStaff(best) ? candidate : best);
  for (const note of target) { note.pitch += shift; note.staff = staff(note.pitch, note.hand); }
  const working = progress?.working ?? spec.start, name = title(config, key), hands = HANDS[config.hands];
  if (!rungs[working]) throw new Error("Saved drill tempo is outside its ladder");
  const octaves = `${config.octaves} octave${config.octaves > 1 ? "s" : ""}`;
  const shapes: Record<string, string> = { Scales: "scale", Arpeggios: "arpeggio", Chords: "chord", Patterns: "pattern" };
  return { id, family: "technique" as const, shape: shapes[spec.group], challenge: 1 + roundEven(4 * rung / Math.max(1, rungs.length - 1)),
    bpm, meter: "4/4", key, title: name, instruction: instruction(config, key, perBeat, bpm), lesson: DRILL_TIPS[config.drill],
    reason: `${spec.summary} Play at any tempo you can hold steadily; the suggestion is ♩ = ${rungs[working].bpm} in ${SUBDIVISIONS[rungs[working].per_beat]}. 3 clean, steady takes in a row earn the slowest tempo among them and raise the suggestion one metronome mark past it; two takes without a clean rep lower it.`,
    purpose: "Drill", cue: spec.octaves.length > 1 ? `${hands} · ${octaves}` : hands, even: config.practice === "even",
    dynamics: config.practice === "even" ? "even" : null, target,
    context: { notation_visible: true, hearings: 0, reveals: 0, hints: 0, familiar: false },
    drill: { drill: config.drill, variant: config.variant, tonic: config.tonic, hands: config.hands, octaves: config.octaves, inversion: config.inversion,
      practice: config.practice, config_key: [config.drill, config.variant, config.tonic, config.hands, config.octaves, config.inversion].join("|"),
      group: spec.group, title: `${name} · ${hands}` + (spec.octaves.length > 1 ? ` · ${octaves}` : ""), per_beat: perBeat, bpm, rung,
      rungs: rungs.length, working, best: progress?.best ?? null, streak: progress?.streak ?? 0, streak_needed: 3, milestone: drillMilestone(config.drill, rung) } };
}
