import type { EventKind, JsonValue, PracticeEvent } from "./events";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class EventLog extends EventTarget {
  private worker = new Worker(new URL("./event-log-worker.ts", import.meta.url), { type: "module" });
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;

  constructor() {
    super();
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
      const request = this.pending.get(data.id);
      if (!request) throw new Error(`Unexpected event log response ${data.id}`);
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    this.worker.onerror = (event) => {
      const error = new Error(`Event log worker failed: ${event.message}`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.closed = true;
    };
  }

  async open(): Promise<{ deviceId: string }> {
    try {
      return await this.send("open");
    } catch (error) {
      this.closed = true;
      this.worker.terminate();
      throw error;
    }
  }

  async append(kind: EventKind, payload: JsonValue, eventId?: string): Promise<PracticeEvent> {
    const event = await this.send<PracticeEvent>("append", { kind, payload, eventId });
    this.dispatchEvent(new Event("append"));
    return event;
  }

  merge(events: PracticeEvent[]): Promise<number> {
    return this.send("merge", { events });
  }

  list(): Promise<PracticeEvent[]> {
    return this.send("list");
  }

  unsynced(userId: string, limit: number): Promise<PracticeEvent[]> {
    return this.send("unsynced", { userId, limit });
  }

  acknowledge(userId: string, ids: string[]): Promise<void> {
    return this.send("acknowledge", { userId, ids });
  }

  cursor(userId: string): Promise<number> {
    return this.send("cursor", { userId });
  }

  applyRemote(userId: string, events: PracticeEvent[], cursor: number): Promise<number> {
    return this.send("applyRemote", { userId, events, cursor });
  }

  async close(): Promise<void> {
    await this.send("close");
    this.closed = true;
    this.worker.terminate();
  }

  private send<T>(action: string, fields: object = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The event log is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ id, action, ...fields });
    });
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
