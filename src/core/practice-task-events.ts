import type { ReadingLogEvent } from "./reading-events.ts";

type Task = { id: string; context: { hearings: number; reveals: number; hints: number } };
type Entry<T> = { task: T; completed: boolean };
type Aid = "hearings" | "reveals" | "hints";

export function practiceTasksFromEvents<T extends Task>(events: ReadingLogEvent[]): Map<string, Entry<T>> {
  const tasks = new Map<string, Entry<T>>();
  const ordered = [...events].sort((a, b) => a.clock - b.clock || compare(a.deviceId, b.deviceId) || compare(a.id, b.id));
  for (const event of ordered) {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
    const payload = event.payload as Record<string, unknown>;
    if (event.kind === "setting" && payload.type === "practice-task") {
      const task = structuredClone(payload.task) as T & { family?: unknown; target?: unknown };
      if (!task || typeof task.id !== "string" || !task.id || !["technique", "reading", "theory", "ear", "repertoire"].includes(task.family as string)
        || !Array.isArray(task.target) || !task.context || tasks.has(task.id)
        || ![task.context.hearings, task.context.reveals, task.context.hints].every((value) => Number.isInteger(value) && value >= 0)) {
        throw new Error("Invalid practice task event");
      }
      tasks.set(task.id, { task, completed: false });
    } else if (event.kind === "setting" && payload.type === "practice-aid") {
      if (typeof payload.taskId !== "string" || !["hearings", "reveals", "hints"].includes(payload.kind as string)) throw new Error("Invalid practice aid event");
      const entry = tasks.get(payload.taskId);
      if (!entry || entry.completed) throw new Error("Aid refers to an unknown or completed practice task");
      entry.task.context[payload.kind as Aid]++;
    } else if (event.kind === "attempt" && Array.isArray(payload.notes) && payload.notes.length) {
      const prompt = payload.prompt;
      if (prompt && typeof prompt === "object" && !Array.isArray(prompt) && typeof (prompt as Record<string, unknown>).id === "string") {
        const entry = tasks.get((prompt as { id: string }).id);
        if (entry) entry.completed = true;
      }
    }
  }
  return tasks;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
