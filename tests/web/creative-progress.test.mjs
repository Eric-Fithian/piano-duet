import assert from "node:assert/strict";
import test from "node:test";
import { waitForCreativeProgress } from "../inference/creative-progress.mjs";

test("creative waits continue while inference advances and stop after completion", async () => {
  let now = 0, index = 0;
  const states = [{ progress: 0 }, { progress: 0 }, { progress: 1 }, { progress: 1 }, { progress: 2 }, { done: true }];
  await waitForCreativeProgress({ label: "Duet", read: async () => states[index++], pause: async () => { now += 1000; },
    diagnostic: async (message) => message, errors: [], now: () => now, maxMs: 10000, stallMs: 2000 });
  assert.equal(index, states.length);
});

test("creative waits fail with the stalled page state", async () => {
  let now = 0;
  await assert.rejects(waitForCreativeProgress({ label: "Variations", read: async () => ({ progress: 1, status: "Analyzing" }),
    pause: async () => { now += 1000; }, diagnostic: async (message) => `${message}; elapsed ${now} ms`, errors: [],
    now: () => now, maxMs: 10000, stallMs: 2000 }),
  (error) => error.message.includes("Variations stopped progressing") && error.message.includes("Analyzing") && error.message.includes("2000 ms"));
});
