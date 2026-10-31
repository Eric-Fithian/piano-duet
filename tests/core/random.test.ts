import assert from "node:assert/strict";
import test from "node:test";
import { RandomSource } from "../../src/core/random.ts";

test("random choices respect weights and sample without replacement", () => {
  const draws = [0.75, 0.1, 0.8, 0.2, 0.5];
  const random = new RandomSource(() => draws.shift()!);
  assert.equal(random.choice(["a", "b", "c", "d"]), "d");
  assert.deepEqual(random.choices([1, 2, 3], [0, 1, 3]), [2]);
  assert.deepEqual(random.choices([1, 2, 3], [0, 1, 3]), [3]);
  assert.deepEqual(random.sample([1, 2, 3], 2), [1, 3]);
  assert.throws(() => random.random(), { message: "Random draws must be in [0, 1)" });
  assert.throws(() => random.choices([1], [0]), { message: "Weighted choices need a positive finite total" });
  assert.throws(() => random.sample([1], 2), { message: "Invalid sample size" });
});
