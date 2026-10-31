import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resample16To441 } from "../../src/core/resample.ts";

test("drill audio resampling matches SciPy's polyphase filter", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
import numpy as np
from scipy.signal import resample_poly
rng = np.random.default_rng(42)
inputs = [np.array([1], dtype=np.float32), np.array([1, -1], dtype=np.float32)]
inputs += [rng.uniform(-1, 1, length).astype(np.float32) for length in (160, 501, 16000)]
print(json.dumps([{'input': samples.tolist(), 'output': resample_poly(samples, 44100, 16000).tolist()} for samples in inputs]))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { input: number[]; output: number[] }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    const actual = resample16To441(Float32Array.from(item.input));
    assert.equal(actual.length, item.output.length);
    let maxError = 0;
    for (let index = 0; index < actual.length; index++) maxError = Math.max(maxError, Math.abs(actual[index] - item.output[index]));
    assert.ok(maxError < 0.000002, `maximum error ${maxError}`);
  }
});
