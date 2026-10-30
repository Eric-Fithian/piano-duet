type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type ReplayEvent = { type: string; [key: string]: Value };

function equal(actual: Value, expected: Value): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(actual), Math.abs(expected));
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, index) => equal(item, expected[index]));
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object"
      && !Array.isArray(actual) && !Array.isArray(expected)) {
    const keys = Object.keys(actual).sort();
    return equal(keys, Object.keys(expected).sort()) && keys.every((key) => equal(actual[key], expected[key]));
  }
  return actual === expected;
}

export class ReadingReplay {
  private cursor = 0;
  private readonly events: ReplayEvent[];

  constructor(events: ReplayEvent[]) {
    this.events = events;
  }

  private take(type: string, actual: { [key: string]: Value }): ReplayEvent {
    const event = this.events[this.cursor++];
    if (!event || event.type !== type || Object.entries(actual).some(([key, value]) => !equal(value, event[key]))) {
      throw new Error(`Reading replay mismatch at event ${this.cursor - 1}: ${JSON.stringify({ type, actual, event })}`);
    }
    return event;
  }

  random(): number {
    return this.take("random", { method: "random", args: [], kwargs: {} }).value as number;
  }

  choice<T extends Value>(options: T[]): T {
    return this.take("random", { method: "choice", args: [options], kwargs: {} }).value as T;
  }

  choices<T extends Value>(population: T[], weights: number[] | null = null, k = 1): T[] {
    return this.take("random", { method: "choices", args: [population], kwargs: { weights, k } }).value as T[];
  }

  sample<T extends Value>(population: T[], k: number): T[] {
    return this.take("random", { method: "sample", args: [population, k], kwargs: {} }).value as T[];
  }

  phrase(context: Value): this {
    this.take("phrase", { context });
    return this;
  }

  note(onset: number, pitches: [number, number][], durations: [number, number][]): [number, number] {
    return this.take("note", { onset, pitches, durations }).value as [number, number];
  }

  chordChance(pitches: number[]): number {
    return this.take("chord_chance", { pitches }).value as number;
  }

  finish(): void {
    if (this.cursor !== this.events.length) throw new Error(`Reading replay left ${this.events.length - this.cursor} events unused`);
  }
}
