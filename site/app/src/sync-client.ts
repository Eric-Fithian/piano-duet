import type { SupabaseClient } from "@supabase/supabase-js";
import { validateEvent } from "./events";
import type { PracticeEvent } from "./events";
import type { EventLog } from "./event-log";

const BATCH_SIZE = 100;

export class SyncClient {
  private running: Promise<number> | undefined;

  constructor(private readonly log: EventLog, private readonly remote: SupabaseClient, private readonly userId: string) {}

  sync(): Promise<number> {
    if (!this.running) {
      this.running = this.exchange().finally(() => { this.running = undefined; });
    }
    return this.running;
  }

  private async exchange(): Promise<number> {
    for (;;) {
      const events = await this.log.unsynced(this.userId, BATCH_SIZE);
      if (!events.length) break;
      const { error } = await this.remote.rpc("push_practice_events", { events });
      if (error) throw error;
      await this.log.acknowledge(this.userId, events.map((event) => event.id));
    }
    let cursor = await this.log.cursor(this.userId);
    let added = 0;
    for (;;) {
      const { data, error } = await this.remote.from("practice_events").select("sequence,event")
        .gt("sequence", cursor).order("sequence").limit(BATCH_SIZE);
      if (error) throw error;
      if (!data.length) break;
      const events: PracticeEvent[] = [];
      for (const row of data) {
        if (!Number.isSafeInteger(row.sequence) || row.sequence <= cursor) throw new Error("Invalid remote event sequence");
        cursor = row.sequence;
        validateEvent(row.event as PracticeEvent);
        events.push(row.event as PracticeEvent);
      }
      added += await this.log.applyRemote(this.userId, events, cursor);
      if (data.length < BATCH_SIZE) break;
    }
    return added;
  }
}
