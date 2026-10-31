export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type EventKind = "attempt" | "song" | "edit" | "exclusion" | "setting";

export interface PracticeEvent {
  id: string;
  deviceId: string;
  clock: number;
  createdAt: string;
  kind: EventKind;
  payload: JsonValue;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Event values must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Event payloads must contain only JSON values");
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function validateEvent(event: PracticeEvent): void {
  if (!event.id || !event.deviceId || !Number.isSafeInteger(event.clock) || event.clock < 1
      || !["attempt", "song", "edit", "exclusion", "setting"].includes(event.kind)
      || !Number.isFinite(Date.parse(event.createdAt))) throw new Error("Invalid practice event");
  canonicalJson(event.payload);
}
