import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Builder } from "selenium-webdriver";
import { MODEL_CATALOG } from "../../site/app/src/model-catalog.ts";
import { startServer } from "./server.mjs";

const directory = process.env.PIANO_ARIA_MODEL_DIR ?? ".cache/models/aria/onnx-int4-block64";
for (const asset of MODEL_CATALOG.aria) {
  const path = `${directory}/${asset.name}`;
  assert.equal((await stat(path)).size, asset.bytes, `${path} has the wrong size`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal(hash.digest("hex"), asset.sha256, `${path} does not match the pinned model`);
}
const fixture = JSON.parse(await readFile("tests/fixtures/aria-sampling.json", "utf8"));
if (fixture.cases.length < 50) throw new Error("At least 50 masked choices are required");
const server = await startServer();
let driver;
try {
  driver = await new Builder().forBrowser("safari").build();
  await driver.manage().setTimeouts({ script: 300000 });
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  const result = await driver.executeAsyncScript(function (cases, done) {
    import("/runtime/ort.webgpu.min.mjs").then(async (ort) => {
      if (!navigator.gpu || !await navigator.gpu.requestAdapter()) throw new Error("Safari has no WebGPU adapter");
      ort.env.wasm.wasmPaths = "/runtime/";
      const options = { executionProviders: ["webgpu"], externalData: [{ path: "model.onnx.data", data: "/models/aria/model.onnx.data" }],
        preferredOutputLocation: Object.fromEntries(Array.from({ length: 16 }, (_, index) => ["key", "value"].map((kind) =>
          [`present_${kind}_${index}`, "gpu-buffer"])).flat()) };
      const session = await ort.InferenceSession.create("/models/aria/model.onnx", options);
      const result = [];
      for (const item of cases) {
        const input = new ort.Tensor("int64", BigInt64Array.from(item.tokens.map(BigInt)), [1, item.tokens.length]);
        const cache = Object.fromEntries(session.inputNames.slice(1).map((name) =>
          [name, new ort.Tensor("float32", new Float32Array(0), [1, 24, 0, 64])]));
        const output = await session.run({ tokens: input, ...cache });
        const logits = output.logits.data, offset = logits.length - output.logits.dims.at(-1);
        result.push(item.allowed.map((index) => logits[offset + index]));
        for (const tensor of [input, ...Object.values(cache), ...Object.values(output)]) tensor.dispose();
      }
      await session.release();
      done({ result, userAgent: navigator.userAgent });
    }).catch((error) => done({ error: `${error.name}: ${error.message}\n${error.stack}` }));
  }, fixture.cases.map(({ tokens, allowed }) => ({ tokens, allowed })));
  if (result.error) throw new Error(result.error);
  assert.equal(result.result.length, fixture.cases.length);
  const rows = fixture.cases.map((item, index) => {
    const reference = distribution(item.fp32_logits, item.weights), mlx = distribution(item.mlx_logits, item.weights);
    const actual = distribution(result.result[index], item.weights);
    const k = Math.min(10, reference.filter(Boolean).length, mlx.filter(Boolean).length, actual.filter(Boolean).length);
    return { mlx: compare(reference, mlx, k), onnx: compare(reference, actual, k) };
  });
  const summary = Object.fromEntries(["mlx", "onnx"].map((name) => {
    const kl = rows.map((row) => row[name].kl).sort((a, b) => a - b);
    return [name, { mean_kl: kl.reduce((sum, value) => sum + value, 0) / kl.length,
      p95_kl: kl[Math.ceil(0.95 * kl.length) - 1],
      mean_top_k_overlap: rows.reduce((sum, row) => sum + row[name].overlap, 0) / rows.length }];
  }));
  const limits = Object.fromEntries(["mean_kl", "p95_kl"].map((metric) => [metric, 1.1 * summary.mlx[metric]]));
  for (const metric of Object.keys(limits)) {
    assert.ok(summary.onnx[metric] <= summary.mlx[metric] && summary.onnx[metric] <= limits[metric], `${metric} exceeds MLX`);
  }
  console.log(JSON.stringify({ contexts: rows.length, userAgent: result.userAgent, summary, limits }, null, 2));
} finally {
  if (driver) await driver.quit();
  await new Promise((resolve) => server.close(resolve));
}

function distribution(logits, weights) {
  if (logits.length !== weights.length || logits.some((value) => !Number.isFinite(value))) throw new Error("Invalid sampling logits");
  const scores = logits.map((value, index) => value / 0.95 + Math.log(weights[index]));
  const max = Math.max(...scores), values = scores.map((value) => value - max >= Math.log(0.035) ? Math.exp(value - max) : 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

function compare(reference, candidate, k) {
  const smooth = (values) => { const padded = values.map((value) => Math.max(value, 1e-12));
    const total = padded.reduce((sum, value) => sum + value, 0); return padded.map((value) => value / total); };
  const p = smooth(reference), q = smooth(candidate);
  const kl = p.reduce((sum, value, index) => sum + value * Math.log(value / q[index]), 0);
  const top = (values) => new Set(values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value).slice(0, k).map(({ index }) => index));
  const expected = top(reference), actual = top(candidate);
  return { kl, overlap: [...expected].filter((index) => actual.has(index)).length / k };
}
