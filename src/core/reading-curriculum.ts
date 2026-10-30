import { musicalKey } from "./musical-key.ts";
import { roundDecimal } from "./numeric.ts";
import { stageRequirements } from "./reading-stage-requirements.ts";
import type { StageRecord } from "./reading-stage-requirements.ts";
import { READING_STAGES } from "./reading-stages.ts";
import { readingTiming } from "./reading-timing.ts";
import type { TimedObservation, TimingContext, TimingTask } from "./reading-timing.ts";

interface CurriculumRecord extends StageRecord { rhythm_pattern: number[][] }
export interface CurriculumAttempt {
  excluded: boolean;
  context: TimingContext & { source: string };
  prompt: TimingTask & {
    id: string; family: string; meter: string; key: { signature: string };
    target: { start: number; duration: number }[];
    reading: TimingTask["reading"] & { clef: string };
  };
  assessment: { observations: (TimedObservation & { expected: number })[]; evidence: { skill: string }[] };
}

export function curriculumProgress(attempts: CurriculumAttempt[], replay: number | null = null) {
  const records = new Map<string, CurriculumRecord[]>(READING_STAGES.map((stage) => [stage.id, []]));
  const earned = new Set<string>();
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.excluded || attempt.context.source !== "microphone") continue;
    const task = attempt.prompt, assessment = attempt.assessment;
    if (task.family !== "reading" || !task.reading || !assessment.evidence.some((item) => item.skill === "reading.pitch")) continue;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const id = task.reading.stage_id;
    if (id === "rests") continue;
    const record: CurriculumRecord = {
      clef: task.reading.clef, key: task.key.signature, meter: task.meter,
      pitch_values: assessment.observations.map((row) => Number(row.matched)),
      pitches: assessment.observations.map((row) => row.expected),
      rhythm: readingTiming(task, assessment.observations, attempt.context),
      rhythm_pattern: task.target.map((note) => [roundDecimal(note.start * task.bpm / 60, 4), roundDecimal(note.duration * task.bpm / 60, 4)]),
    };
    for (const stageId of id == null ? ["first_notes", "steps_skips"] : [id]) {
      const stage = READING_STAGES.find((item) => item.id === stageId);
      const stageRecords = records.get(stageId);
      if (!stage || !stageRecords) throw new Error(`Unknown reading stage ${stageId}`);
      stageRecords.push(record);
      if (!earned.has(stageId) && stageRequirements(stage, stageRecords).ready) earned.add(stageId);
    }
  }
  const current = READING_STAGES.find((stage) => !earned.has(stage.id)) ?? READING_STAGES.at(-1)!;
  let target = current;
  if (replay !== null) {
    if (!Number.isInteger(replay) || replay < 1 || replay > READING_STAGES.length) throw new Error(`Reading stages run from 1 to ${READING_STAGES.length}`);
    target = READING_STAGES[replay - 1];
    if (!earned.has(target.id) && target.id !== current.id) throw new Error(`Stage ${replay} is locked until the earlier stages are complete`);
  }
  const path = READING_STAGES.map((stage) => ({
    id: stage.id, number: stage.number, label: stage.label, description: stage.description, phase: stage.phase,
    status: earned.has(stage.id) ? "Complete" : stage.id === current.id ? "Current" : "Ahead",
    rhythm_required: stage.rhythm_required, rhythm_scope: stage.rhythm_scope, minimum_bpm: stage.tempo,
    ...stageRequirements(stage, records.get(stage.id)!),
  }));
  const targetRecords = records.get(target.id)!;
  const contexts = new Map<string, { clef: string; key: string; meter: string; samples: number }>();
  for (const row of targetRecords) {
    const key = JSON.stringify([row.clef, row.key, row.meter]);
    const existing = contexts.get(key);
    if (existing) existing.samples++;
    else contexts.set(key, { clef: row.clef, key: row.key, meter: row.meter, samples: 1 });
  }
  return {
    current: current.id, number: current.number, label: current.label, completed: earned.size, total: READING_STAGES.length,
    path, finished: READING_STAGES.every((stage) => earned.has(stage.id)), contexts: [...contexts.values()],
    target: target.id, target_number: target.number, key_names: target.keys.map(([tonic, mode]) => musicalKey(tonic, mode).name),
    demonstrated_keys: path[target.number - 1].key_signatures, recent_rhythms: targetRecords.slice(-4).map((row) => row.rhythm_pattern),
  };
}
