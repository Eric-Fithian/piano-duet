import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { roundDecimal } from "../../src/core/numeric.ts";

test("decimal rounding matches Python for binary fractions and ties", () => {
  const values = [2.675, -2.675, 0.125, -0.125, 0.025, 0.075];
  for (let denominator = 1; denominator <= 100; denominator++) {
    for (let numerator = 0; numerator <= denominator; numerator++) values.push(numerator / denominator);
  }
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
values = json.loads(sys.stdin.readline())
print(json.dumps([round(value, 2) for value in values]))
`], { input: JSON.stringify(values) + "\n", encoding: "utf8", timeout: 300_000 });
  assert.equal(reference.status, 0, reference.stderr);
  assert.deepEqual(values.map((value) => roundDecimal(value, 2)), JSON.parse(reference.stdout));
});
