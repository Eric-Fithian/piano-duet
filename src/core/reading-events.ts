import { readingProgress } from "./reading-progress.ts";
import type { ProgressAttempt } from "./reading-progress.ts";

export interface ReadingLogEvent {
  id: string;
  deviceId: string;
  clock: number;
  createdAt: string;
  kind: string;
  payload: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function readingProgressFromEvents(events: ReadingLogEvent[]) {
  const ordered = [...events].sort((a, b) => a.clock - b.clock || compare(a.deviceId, b.deviceId) || compare(a.id, b.id));
  const seen = new Set<string>();
  const excluded = new Map<string, boolean>();
  const attempts: ProgressAttempt[] = [];
  for (const event of ordered) {
    if (!event.id || !event.deviceId || !Number.isSafeInteger(event.clock) || event.clock < 1 || !Number.isFinite(Date.parse(event.createdAt))) {
      throw new Error("Invalid practice event");
    }
    if (seen.has(event.id)) throw new Error(`Duplicate practice event ${event.id}`);
    seen.add(event.id);
    if (event.kind === "exclusion") {
      const payload = object(event.payload, "Exclusion");
      if (typeof payload.attemptId !== "string" || !payload.attemptId || typeof payload.excluded !== "boolean") throw new Error("Invalid exclusion event");
      excluded.set(payload.attemptId, payload.excluded);
    } else if (event.kind === "attempt") {
      const payload = object(event.payload, "Attempt");
      const prompt = object(payload.prompt, "Attempt prompt");
      const context = object(payload.context, "Attempt context");
      const assessment = object(payload.assessment, "Attempt assessment");
      if (typeof prompt.family !== "string" || typeof context.source !== "string" || !Array.isArray(assessment.evidence)) throw new Error("Invalid attempt event");
      if (prompt.family === "reading") {
        if (typeof prompt.id !== "string" || !prompt.id || !Array.isArray(prompt.target)
            || !Array.isArray(assessment.observations)) throw new Error("Invalid reading attempt event");
        object(prompt.reading, "Reading prompt");
        attempts.push({ ...payload, id: event.id, created_at: Date.parse(event.createdAt) / 1000, excluded: false } as unknown as ProgressAttempt);
      }
    }
  }
  for (const attempt of attempts) attempt.excluded = excluded.get(String(attempt.id)) ?? false;
  return readingProgress(attempts);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
