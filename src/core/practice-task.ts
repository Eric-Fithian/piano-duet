import { musicalKey } from "./musical-key.ts";
import type { MusicalKey } from "./musical-key.ts";
import { pitchName } from "./reading-assessment.ts";
import { choosePracticeFocus, selectPracticeKey } from "./practice-selection.ts";
import type { PracticeFamily, PracticePurpose, SelectionAttempt, SelectionProfile } from "./practice-selection.ts";
import type { PracticeNote } from "./practice-assessment.ts";

export interface PracticePiece { id: string; title: string; key: MusicalKey; challenge: number; bpm: number | null; notes: PracticeNote[] }
type RecentAttempt = SelectionAttempt & { excluded: boolean; key: MusicalKey | null; shape: string | null;
  assessment: SelectionAttempt["assessment"] & { observations: { expected: number }[] } };
type TaskProfile = Omit<SelectionProfile, "practice_recent"> & { practice_recent: RecentAttempt[]; recent: RecentAttempt[] };
export interface TaskRandom { choice<T>(options: T[]): T; choices<T extends number>(options: T[], weights: number[]): T[] }
export interface GeneratedPracticeTask {
  id: string; family: Exclude<PracticeFamily, "reading">; challenge: number; bpm: number | null; meter: string; key: MusicalKey;
  reason: string; purpose: PracticePurpose; context: { notation_visible: boolean; hearings: number; reveals: number; hints: number; familiar: boolean };
  target: PracticeNote[]; title: string; instruction: string; lesson: string; shape: string; cue: string; even: boolean; dynamics: string | null; piece_id?: string;
}

export function practiceSequence(pitches: number[], bpm: number, beats: number[] = pitches.map(() => 1)): PracticeNote[] {
  if (pitches.length !== beats.length) throw new Error("Each pitch requires a duration");
  let position = 0;
  return pitches.map((pitch, index) => {
    const length = beats[index], note = { pitch, start: position * 60 / bpm, duration: length * 60 / bpm, velocity: 76 };
    position += length; return note;
  });
}

export function generatePracticeTask(profile: TaskProfile, focus: "guided" | Exclude<PracticeFamily, "reading">, id: string,
  rng: TaskRandom, now: number, pieces: PracticePiece[], attempts: { prompt: { piece_id?: unknown }; notes: unknown[]; excluded: boolean }[], pieceId?: string | null): GeneratedPracticeTask {
  const [chosen, selectedPurpose, reason] = focus === "guided" ? choosePracticeFocus(profile, now)
    : [focus, "Explore", "Practice the focus you selected."] as const;
  if (chosen === "reading") throw new Error("Reading tasks require the reading composer");
  const family = chosen;
  const skills = new Map(profile.skills.map((skill) => [skill.id, skill]));
  const getSkill = (name: string) => { const skill = skills.get(name); if (!skill) throw new Error(`Missing practice skill ${name}`); return skill; };
  const anchors = { technique: "technique.scales", theory: "theory.chords", ear: "ear.pitch", repertoire: "repertoire.recall" };
  let skill = getSkill(anchors[family]);
  let theoryShape = "chord";
  if (family === "theory" && getSkill("theory.chords").attempts > getSkill("theory.scales").attempts) {
    theoryShape = "scale"; skill = getSkill("theory.scales");
  }
  let challenge = Math.min(5, (skill.level ?? 0) + 1), purpose: PracticePurpose = selectedPurpose;
  if (skill.accuracy !== null && skill.accuracy < 70) { challenge = Math.max(1, skill.challenge - 1); purpose = "Repair"; }
  let [key, keyReason] = selectPracticeKey(skill);
  const diagnostic = purpose === "Check" ? profile.practice_recent[0] : null;
  if (diagnostic) { if (!diagnostic.key) throw new Error("Diagnostic requires a key"); key = diagnostic.key; keyReason = ""; }
  if (family === "ear" && challenge === 1) { key = musicalKey(0, "major"); keyReason = "Start with a small range in C major."; }
  const bpm = [50, 60, 76, 92, 112][challenge - 1], root = 60 + key.tonic, rootName = `${key.name.split(" ")[0]}4`;
  const intervals = key.mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  let scale = [...intervals.map((step) => root + step), root + 12];
  const task: GeneratedPracticeTask = { id, family, challenge, bpm, meter: "4/4", key, reason: `${reason} ${keyReason}`, purpose,
    context: { notation_visible: family === "technique", hearings: 0, reveals: 0, hints: 0, familiar: false },
    target: [], title: "", instruction: "", lesson: "", shape: "melody", cue: "", even: false, dynamics: null };
  const chordConditions = getSkill("technique.chords").conditions.filter((row) => row.id.startsWith("chord:") && row.accuracy !== null && row.accuracy < 80);
  if (family === "technique" && (diagnostic || chordConditions.length)) {
    let pitches: number[], shape: string;
    if (diagnostic) { pitches = diagnostic.assessment.observations.map((row) => row.expected); shape = diagnostic.shape!; }
    else {
      const condition = chordConditions.reduce((a, b) => b.accuracy! < a.accuracy! ? b : a);
      pitches = condition.id.split(":")[1].split(",").map(Number); shape = "chord";
      const source = profile.recent.find((attempt) => !attempt.excluded && attempt.assessment.evidence.some((row) => row.facet === condition.id));
      if (source?.key) key = source.key;
    }
    Object.assign(task, { key, shape, challenge: 1, bpm: 50, even: shape === "scale", dynamics: null,
      title: diagnostic ? "Find the notes with a guide" : "Give this chord some room",
      instruction: "Play the notes shown at a comfortable, steady pace. For a chord, play all its notes together, four times with space between attacks.",
      lesson: "Use the note names to find the keys before you begin. Start slowly. We are checking this particular pattern, without asking you to recall its notes.",
      target: shape === "chord" ? Array.from({ length: 4 }, (_, attack) => pitches.map((pitch) => ({ pitch, start: attack * 2.4, duration: 1.2, velocity: 76 }))).flat() : practiceSequence(pitches, 50),
      cue: pitches.map((pitch) => pitchName(pitch, key)).join(shape === "chord" ? " + " : " → "),
      reason: diagnostic || purpose === "Repair" ? reason : "Your other playing showed a difficult chord. Give that pattern some focused practice." });
    return task;
  }
  if (family === "technique" || family === "theory") {
    const shape = family === "technique" ? "scale" : theoryShape;
    task.shape = shape;
    if (shape === "scale") {
      if (challenge >= 4) scale = [...scale, ...scale.slice(1).map((pitch) => pitch + 12)];
      const pitches = family === "technique" ? [...scale, ...scale.slice(0, -1).reverse()] : scale;
      task.target = practiceSequence(pitches, bpm);
      const titleKey = key.name.replace("minor", key.mode === "minor" ? "natural minor" : "minor");
      task.title = `${titleKey} scale`;
      let direction = family === "technique" ? "up and back down" : "upward";
      if (family === "theory" && [3, 5].includes(challenge)) { task.target = practiceSequence([...pitches].reverse(), bpm); direction = "downward"; }
      task.instruction = `Play the ${titleKey} scale ${direction}, starting on ${rootName}. Use one hand.`;
      if (direction === "downward") task.instruction = `Play the ${titleKey} scale downward. Start ${challenge === 5 ? 2 : 1} octave(s) above ${rootName}.`;
      task.even = family === "technique";
      if (task.even) task.instruction += ` Aim for an even sound and one note per beat at ${bpm} BPM. Start slower if you need to.`;
      else { task.instruction += " Work out the notes yourself, or reveal the score for help. Timing is optional."; task.bpm = null; }
    } else {
      let pitches = [root, root + (key.mode === "major" ? 4 : 3), root + 7];
      const inversion = challenge === 3 ? "first inversion" : challenge === 4 ? "second inversion" : null;
      if (challenge === 3) pitches = [...pitches.slice(1), root + 12];
      else if (challenge === 4) pitches = [...pitches.slice(2), root + 12, pitches[1] + 12];
      else if (challenge === 5) pitches.push(root + (key.mode === "major" ? 11 : 10));
      task.target = pitches.map((pitch) => ({ pitch, start: 0, duration: 2, velocity: 76 }));
      task.title = `Build a ${key.name} chord`;
      task.instruction = `Play a ${key.name} triad as one chord, starting with ${rootName} as its lowest note. Work out the other two notes, or reveal the score for help.`;
      if (inversion) {
        task.title += ` · ${inversion}`;
        task.instruction = `Build the ${key.name} triad from ${rootName}, then play its ${inversion}: move the lowest ${challenge === 3 ? 1 : 2} note(s) up an octave. Play all three notes together.`;
      } else if (challenge === 5) {
        task.title = `Build a ${key.name} seventh chord`;
        task.instruction = `Build a ${key.name} seventh chord in root position, beginning on ${rootName}. Include the root, third, fifth, and seventh. Play the four notes together.`;
      }
      task.bpm = null;
    }
    task.lesson = shape === "scale"
      ? "A major scale steps whole, whole, half, whole, whole, whole, half; natural minor steps whole, half, whole, whole, half, whole, whole. A half step is the next key, including black keys."
      : "A major triad has a root, a note 4 half steps above it, and a note 7 half steps above it. A minor triad uses 3 and 7 half steps. Count every key, including black keys.";
    if (shape === "chord" && challenge === 5) task.lesson += " The major seventh is 11 half steps above the root; the minor seventh is 10.";
  } else if (family === "ear") {
    const conditions = new Map(skill.conditions.map((row) => [row.id, row]));
    const pool = intervals.slice(0, Math.min(7, 4 + challenge)).map((step) => 60 + key.tonic + step);
    const weights = pool.map((pitch) => 1 + (100 - (conditions.get(`pitch:${pitch}`)?.accuracy ?? 0)) / 20);
    const length = [4, 5, 6, 8, 10][challenge - 1], limit = Math.max(2, Math.floor(length / 3));
    let generated = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const pitches: number[] = [];
      for (let i = 0; i < length; i++) {
        const available = pool.filter((pitch) => pitches.filter((value) => value === pitch).length < limit
          && !(pitches.length >= 2 && pitches.at(-1) === pitch && pitches.at(-2) === pitch));
        pitches.push(rng.choices(available, available.map((pitch) => weights[pool.indexOf(pitch)]))[0]);
      }
      if (new Set(pitches).size < Math.min(3, length)) continue;
      const beats = challenge >= 3 ? pitches.map(() => rng.choice([0.5, 0.5, 1])) : pitches.map(() => 1);
      task.target = practiceSequence(pitches, bpm, beats); generated = true; break;
    }
    if (!generated) throw new Error("Could not generate an ear-training melody");
    task.title = "From your ear to the keys";
    task.instruction = "Hear the short melody, then play it back from memory. It starts near middle C. Take a slower, steady pace if needed.";
    task.lesson = "Middle C is immediately to the left of the pair of black keys nearest the center of the piano. Read the upper staff with the right hand and the lower staff with the left hand. A higher note on the page means a higher key.";
  } else {
    const piece = pieceId ? pieces.find((item) => item.id === pieceId) : pieces.at(-1);
    if (!piece) throw new Error("Unknown practice piece");
    const familiar = attempts.some((attempt) => attempt.prompt.piece_id === piece.id && attempt.notes.length > 0 && !attempt.excluded);
    Object.assign(task, { title: piece.title, piece_id: piece.id, key: piece.key, challenge: piece.challenge, bpm: piece.bpm, target: piece.notes,
      instruction: `${familiar ? "Play this piece from memory" : "Learn this short piece"}. Reveal the score or hear it whenever you need help. Later, try it without either.`,
      reason: "Return to a piece you have chosen to keep. Repetitions build familiarity; an unaided attempt gives evidence about recall.",
      lesson: "Learn a small part at a time. When you can play it comfortably, look away and try it again. Use a steady tempo that lets you keep going." });
    task.context.familiar = familiar; task.context.notation_visible = !familiar;
  }
  task.cue = family === "technique" ? task.target.map((note) => pitchName(note.pitch, key)).join(" → ") : "";
  task.dynamics = task.even ? "even" : null;
  return task;
}
