import type { ReadingLogEvent } from "./reading-events.ts";

type Row = Record<string, unknown>;
export interface LegacyHistory {
  attempts: Row[]; tasks: Row[]; pieces: Row[]; songs: Row[]; song_plays: Row[];
}

function parse(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Invalid history JSON");
  const result: unknown = JSON.parse(value);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid history record");
  return result as Record<string, unknown>;
}

function id(row: Row): string {
  if (typeof row.id !== "string" || !row.id) throw new Error("Invalid history record identity");
  return row.id;
}

function time(row: Row): number {
  if (typeof row.created_at !== "number" || !Number.isFinite(row.created_at)) throw new Error("Invalid history timestamp");
  return row.created_at;
}

export function historyEvents(history: LegacyHistory): ReadingLogEvent[] {
  const pending: { event: Omit<ReadingLogEvent, "clock">; at: number; order: number }[] = [];
  let order = 0;
  const add = (eventId: string, kind: string, payload: unknown, at: number) => {
    pending.push({ event: { id: eventId, deviceId: "mac-app-history", createdAt: new Date(at * 1000).toISOString(), kind, payload }, at, order: order++ });
  };
  for (const row of history.attempts) {
    const attemptId = id(row), at = time(row), inputs = parse(row.inputs), assessment = parse(row.assessment);
    if (row.excluded !== 0 && row.excluded !== 1) throw new Error("Invalid history exclusion");
    add(attemptId, "attempt", { ...inputs, assessment, legacyCreatedAt: at }, at);
    if (row.excluded === 1) add(`mac-exclusion:${attemptId}`, "exclusion", { attemptId, excluded: true }, at);
  }
  for (const row of history.tasks) {
    const taskId = id(row), at = time(row), task = parse(row.task);
    if (task.id !== taskId || (row.fingerprint !== null && typeof row.fingerprint !== "string")
      || (row.completed !== 0 && row.completed !== 1)) throw new Error("Invalid history task");
    add(`mac-task:${taskId}`, "setting", { type: "mac-task", task, fingerprint: row.fingerprint, completed: row.completed === 1, created_at: at }, at);
  }
  for (const row of history.pieces) {
    const piece = parse(row.piece);
    if (piece.id !== id(row)) throw new Error("Invalid saved piece");
    add(`mac-piece:${id(row)}`, "song", { type: "piece", piece }, 0);
  }
  for (const row of history.songs) {
    const song = parse(row.song), at = time(row);
    if (song.id !== id(row)) throw new Error("Invalid history song");
    add(`mac-song:${id(row)}`, "song", { action: "import", song, legacyCreatedAt: at }, at);
  }
  for (const row of history.song_plays) {
    const play = parse(row.play), at = time(row);
    if (typeof row.song_id !== "string" || typeof play.version !== "string" || !Array.isArray(play.attacks)) throw new Error("Invalid history song play");
    add(`mac-play:${id(row)}`, "song", { action: "play", songId: row.song_id, ...play, legacyCreatedAt: at }, at);
  }
  pending.sort((a, b) => a.at - b.at || a.order - b.order);
  return pending.map(({ event }, index) => ({ ...event, clock: index + 1 }));
}
