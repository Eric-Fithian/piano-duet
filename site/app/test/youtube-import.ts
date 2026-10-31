import musicXml from "../../../tests/fixtures/score-writing/reference.musicxml?raw";
import { LocalService } from "../../../src/core/local-service.ts";
import type { LocalEventStore, LocalJsonValue } from "../../../src/core/local-service.ts";
import type { ReadingLogEvent } from "../../../src/core/reading-events.ts";
import { setLocalService } from "../../../src/piano_duet/static/practice.mjs";
import { setupYoutubeImport } from "../src/youtube-import.ts";

const events: ReadingLogEvent[] = [];
const store: LocalEventStore = { async list() { return [...events]; }, async append(kind, payload: LocalJsonValue, id) {
  const event = { id: id ?? crypto.randomUUID(), kind, payload, deviceId: "test-device", clock: events.length + 1, createdAt: new Date().toISOString() };
  events.push(event); return event;
} };
const importer = { async run(data: ArrayBuffer) {
  Object.assign(window, { receivedAudio: Array.from(new Uint8Array(data)) });
  return { musicXml, notes: Array.from({ length: 13 }, (_, index) => ({ start: index * 0.5 })) };
} };
const service = new LocalService(store, undefined, undefined, undefined, undefined, undefined, undefined, importer);
setLocalService(service);
setupYoutubeImport(async () => { Object.assign(window, { savedEvents: events }); });
document.querySelector<HTMLButtonElement>('[data-close="youtubeDialog"]')!.addEventListener("click", () => document.querySelector<HTMLDialogElement>("#youtubeDialog")!.close());
Object.assign(window, { youtubeTestReady: true });
