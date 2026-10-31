import assert from "node:assert/strict";
import test from "node:test";
import { ReadingReplay } from "./reading-replay.ts";
import type { ReplayEvent } from "./reading-replay.ts";

test("composition replay checks order, options, context and complete consumption", () => {
  const events: ReplayEvent[] = [
    { type: "random", method: "choice", args: [["treble", "bass"]], kwargs: {}, draws: [], value: "bass" },
    { type: "phrase", context: null },
    { type: "note", onset: 0, pitches: [[48, 2], [50, 3]], durations: [[0.5, 1]], random: [], value: [50, 0.5] },
    { type: "chord_chance", pitches: [55, 59], value: 0.3 },
  ];
  const replay = new ReadingReplay(events);
  assert.equal(replay.choice(["treble", "bass"]), "bass");
  const phrase = replay.phrase(null);
  assert.deepEqual(phrase.note(0, [[48, 2], [50, 3]], [[0.5, 1]]), [50, 0.5]);
  assert.equal(phrase.chordChance([55, 59]), 0.3);
  replay.finish();
  assert.throws(() => new ReadingReplay(events).choice(["treble"]), (error: Error) => error.message.includes("mismatch"));
  assert.throws(() => new ReadingReplay(events).phrase(null), (error: Error) => error.message.includes("mismatch"));
  assert.throws(() => new ReadingReplay(events).finish(), { message: "Reading replay left 4 events unused" });
});

test("the replay accepts the Python recorder's complete stream for all stages", async () => {
  const { spawnSync } = await import("node:child_process");
  const reference = spawnSync("uv", ["run", "--frozen", "python", "tests/reading_recording.py"], { encoding: "utf8", timeout: 300_000, maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { events: ReplayEvent[] }[] = JSON.parse(reference.stdout);
  assert.equal(cases.length, 48);
  for (const { events } of cases) {
    const replay = new ReadingReplay(events);
    for (const event of events) {
      if (event.type === "phrase") replay.phrase(event.context);
      else if (event.type === "note") replay.note(event.onset as number, event.pitches as [number, number][], event.durations as [number, number][]);
      else if (event.type === "chord_chance") replay.chordChance(event.pitches as number[]);
      else if (event.type === "random") {
        const args = event.args as unknown[];
        const kwargs = event.kwargs as { weights?: number[] | null; k?: number };
        if (event.method === "random") replay.random();
        else if (event.method === "choice") replay.choice(args[0] as number[]);
        else if (event.method === "choices") replay.choices(args[0] as number[], kwargs.weights, kwargs.k);
        else if (event.method === "sample") replay.sample(args[0] as number[], args[1] as number);
        else throw new Error(`Unexpected random method ${event.method}`);
      } else throw new Error(`Unexpected replay event ${event.type}`);
    }
    replay.finish();
  }
});
