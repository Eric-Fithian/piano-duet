import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resample16To441, resampleTo441 } from "../../src/core/resample.ts";

test("drill audio resampling matches SciPy's polyphase filter", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
import numpy as np
from scipy.signal import resample_poly
rng = np.random.default_rng(42)
inputs = [np.array([1], dtype=np.float32), np.array([1, -1], dtype=np.float32)]
inputs += [rng.uniform(-1, 1, length).astype(np.float32) for length in (160, 501, 16000)]
print(json.dumps([{'input': samples.tolist(), 'output': resample_poly(samples, 44100, 16000).tolist()} for samples in inputs]))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
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

test("audio-file resampling matches SciPy at common native rates", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json
import numpy as np
from scipy.signal import resample_poly
samples = (np.sin(np.arange(4096, dtype=np.float32) / 7) * .7).astype(np.float32)
print(json.dumps({'input': samples.tolist(), 'outputs': {str(rate): resample_poly(samples, 44100, rate).tolist() for rate in (22050, 32000, 48000)}}))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const fixture: { input: number[]; outputs: Record<string, number[]> } = JSON.parse(reference.stdout);
  for (const [rate, expected] of Object.entries(fixture.outputs)) {
    const actual = resampleTo441(Float32Array.from(fixture.input), Number(rate));
    assert.equal(actual.length, expected.length);
    const maximum = actual.reduce((error, value, index) => Math.max(error, Math.abs(value - expected[index])), 0);
    assert.ok(maximum < 0.000002, `${rate} Hz maximum error ${maximum}`);
  }
});
