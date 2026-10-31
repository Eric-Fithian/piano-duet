import type { ReadingLogEvent } from "./reading-events.ts";
import type { Song, SongPlay } from "./library.ts";

export type LibraryState = { songs: Map<string, Song>; plays: Map<string, SongPlay[]> };

export function libraryFromEvents(events: ReadingLogEvent[]): LibraryState {
  const ordered = [...events].sort((a, b) => a.clock - b.clock || compare(a.deviceId, b.deviceId) || compare(a.id, b.id));
  const songs = new Map<string, Song>(), plays = new Map<string, SongPlay[]>(), removed = new Set<string>(), seen = new Set<string>();
  for (const event of ordered) {
    if (!event.id || !event.deviceId || !Number.isSafeInteger(event.clock) || event.clock < 1 || !Number.isFinite(Date.parse(event.createdAt))) throw new Error("Invalid library event");
    if (seen.has(event.id)) throw new Error(`Duplicate event ${event.id}`);
    seen.add(event.id);
    if (event.kind !== "song" && event.kind !== "edit") continue;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new Error("Invalid library event payload");
    const payload = event.payload as Record<string, unknown>;
    if (event.kind === "song" && "piece" in payload) continue;
    if (event.kind === "song" && payload.action === "import") {
      if (!payload.song || typeof payload.song !== "object" || Array.isArray(payload.song)) throw new Error("Invalid imported song");
      const song = payload.song as Omit<Song, "created_at">;
      if (typeof song.id !== "string" || !song.id || songs.has(song.id) || typeof song.title !== "string" || !Array.isArray(song.notes)) throw new Error("Invalid imported song");
      songs.set(song.id, { ...song, created_at: Date.parse(event.createdAt) / 1000 });
      plays.set(song.id, []);
    } else if (event.kind === "song" && payload.action === "delete") {
      if (typeof payload.songId !== "string" || !songs.has(payload.songId)) throw new Error("Deleting an unknown song");
      removed.add(payload.songId);
    } else if (event.kind === "song" && payload.action === "play") {
      if (typeof payload.songId !== "string" || !songs.has(payload.songId) || typeof payload.version !== "string" || !Array.isArray(payload.attacks)) throw new Error("Invalid song play");
      plays.get(payload.songId)!.push({ created_at: Date.parse(event.createdAt) / 1000, version: payload.version, attacks: payload.attacks as [number, boolean][] });
    } else if (event.kind === "edit" && payload.action === "song") {
      if (typeof payload.songId !== "string" || !songs.has(payload.songId) || !payload.song || typeof payload.song !== "object" || Array.isArray(payload.song)) throw new Error("Invalid song edit");
      const song = payload.song as Song;
      if (song.id !== payload.songId) throw new Error("A song edit changed its identity");
      songs.set(song.id, song);
    } else throw new Error("Unknown library event");
  }
  for (const id of removed) { songs.delete(id); plays.delete(id); }
  return { songs, plays };
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
