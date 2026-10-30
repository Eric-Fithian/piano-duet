import { assessReading } from "../../../src/core/reading-assessment.ts";
import type { ReadingScore } from "../../../src/core/reading-composer.ts";
import { readingProgressFromEvents } from "../../../src/core/reading-events.ts";
import { musicalKey } from "../../../src/core/musical-key.ts";
import { EventLog } from "../src/event-log";
import type { JsonValue } from "../src/events";

let log: EventLog;
Object.assign(window, {
  async openReadingLog() { log = new EventLog(); return log.open(); },
  async closeReadingLog() { return log.close(); },
  async readingProgress() { return readingProgressFromEvents(await log.list()); },
  async excludeReading(id: string, excluded: boolean) { return log.append("exclusion", { attemptId: id, excluded }); },
  async saveReading() {
    const target = [60, 62, 64, 60].map((pitch, index) => ({ pitch, start: index * 0.5, duration: 0.5, velocity: 76, staff: "treble" }));
    const score: ReadingScore = { target, title: "First notes", summary: "Read", instruction: "Read", bpm: 60, meter: "4/4",
      key: musicalKey(0, "major"), challenge: 1, reason: "Read", lesson: "Read",
      reading: { stage_id: "first_notes", stage_number: 1, focus: "shifts", label: "First notes", clef: "treble", hand: "right",
        segments: [0], positions: [{ index: 0, low: 23, finger: 1, clef: "treble", hand: "right" }], bars_per_row: 2,
        vocabulary: [60, 62, 64], max_step: 2, introduce: null, bars: 1, rhythm_required: false, minimum_bpm: 0, composition: { method: "aria" } } };
    const groups = target.map((note) => [{ pitch: note.pitch, start: note.start + 1, velocity: 80, confidence: 0.95 }]);
    const context = { source: "microphone", interaction: "step_by_step", hearings: 0, reveals: 0, hints: 0, reading_timing: { interruptions: [] } };
    const { assessment } = assessReading(score, groups, context);
    const payload = { prompt: { ...score, family: "reading", id: crypto.randomUUID() }, context, assessment };
    return log.append("attempt", JSON.parse(JSON.stringify(payload)) as JsonValue);
  },
});
