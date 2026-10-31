import assert from "node:assert/strict";
import test from "node:test";
import { hasSpacedOnsets } from "../inference/capture-onsets.mjs";

test("synthetic phrase onsets must preserve the scheduled spacing", () => {
  assert.equal(hasSpacedOnsets([0.2, 0.89, 1.6], 3, 0.7, 0.15), true);
  assert.equal(hasSpacedOnsets([0.2, 0.35, 0.9, 1.6], 3, 0.7, 0.15), true);
  assert.equal(hasSpacedOnsets([0.2, 0.21, 0.23], 3, 0.7, 0.15), false);
  assert.equal(hasSpacedOnsets([0.2, 0.9], 3, 0.7, 0.15), false);
  assert.throws(() => hasSpacedOnsets([0.9, 0.2], 2, 0.7, 0.15), { message: "Invalid captured-onset comparison" });
});
