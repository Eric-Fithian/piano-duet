import * as ort from "/runtime/ort.webgpu.min.mjs";

ort.env.wasm.numThreads = navigator.hardwareConcurrency;
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = new URL("/runtime/", self.location.origin).href;

function errors(actual, expected) {
  if (actual.length !== expected.length) throw new Error("Output lengths differ");
  let max = 0;
  let squared = 0;
  for (let index = 0; index < actual.length; index++) {
    const difference = actual[index] - expected[index];
    max = Math.max(max, Math.abs(difference));
    squared += difference * difference;
  }
  return { max_absolute_error: max, rmse: Math.sqrt(squared / actual.length) };
}

function liveNotes(onset, frame, velocity, frames, threshold = 0.8) {
  const notes = [];
  for (let time = 2; time < frames - 2; time++) {
    for (let pitch = 0; pitch < 88; pitch++) {
      const at = (offset) => onset[(time + offset) * 88 + pitch];
      if (at(0) <= threshold || at(0) < at(-1) || at(-1) < at(-2)
          || at(0) < at(1) || at(1) < at(2)) continue;
      const shift = (at(1) - at(-1)) / (at(0) - (at(-1) > at(1) ? at(1) : at(-1))) / 2;
      const start = (time + shift) / 100;
      if (start < 0.25 || start > 1.85) continue;
      let sustained = 0;
      for (let index = time; index < Math.min(frames, time + 6); index++) {
        if (frame[index * 88 + pitch] >= 0.3) sustained++;
      }
      if (sustained < 3) continue;
      notes.push({ pitch: pitch + 21, start, velocity: Math.max(1, Math.min(127, Math.round(velocity[time * 88 + pitch] * 128))), confidence: at(0) });
    }
  }
  return notes;
}

async function measure(model, backend, verbose) {
  const providerDiagnostics = [];
  let collecting = verbose;
  if (verbose) for (const method of ["debug", "info", "log", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const message = args.map(String).join(" "), lower = message.toLowerCase();
      if (collecting && ["node", "provider", "kernel", "execution"].some((term) => lower.includes(term))) providerDiagnostics.push(message);
      original(...args);
    };
  }
  ort.env.logLevel = verbose ? "verbose" : "warning";
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  if (["webgpu", "split-fp32"].includes(backend) && !adapter) throw new Error("WebGPU adapter unavailable");
  const split = backend === "split-fp32";
  const options = { executionProviders: [split ? "webgpu" : backend], logSeverityLevel: verbose ? 0 : 2,
    graphOptimizationLevel: model === "transcription" ? "disabled" : "all" };
  const started = performance.now();
  if (model === "transcription") {
    const fixture = await (await fetch("/fixtures/transcription.json")).json();
    const session = await ort.InferenceSession.create(
      split ? "/models/transcription-convolution-fp32.onnx" : "/models/transcription.onnx", options);
    const recurrent = split ? await ort.InferenceSession.create(
      "/models/transcription-recurrent.onnx", { ...options, executionProviders: ["wasm"] }) : null;
    collecting = false;
    const loaded = performance.now();
    const input = new ort.Tensor("float32", Float32Array.from(fixture.audio), [1, fixture.audio.length]);
    const runs = [];
    const convolutionRuns = [];
    const recurrentRuns = [];
    let result;
    for (let index = 0; index < 6; index++) {
      const runStart = performance.now();
      if (recurrent) {
        const intermediate = await session.run({ [session.inputNames[0]]: input });
        const recurrentStart = performance.now();
        result = await recurrent.run(intermediate, ["reg_onset", "frame", "velocity"]);
        convolutionRuns.push(recurrentStart - runStart);
        recurrentRuns.push(performance.now() - recurrentStart);
        for (const value of Object.values(intermediate)) value.dispose();
      } else {
        result = await session.run({ [session.inputNames[0]]: input }, ["reg_onset", "frame", "velocity"]);
      }
      runs.push(performance.now() - runStart);
    }
    const notes = liveNotes(result.reg_onset.data, result.frame.data, result.velocity.data, result.reg_onset.dims[1]);
    return { model, backend, userAgent: navigator.userAgent, gpu: Boolean(adapter), ...(verbose ? { providerDiagnostics } : {}),
      input_samples: fixture.audio.length, threads: ort.env.wasm.numThreads, isolated: crossOriginIsolated,
      simd: ort.env.wasm.simd,
      load_ms: loaded - started, runs_ms: runs, convolution_ms: convolutionRuns, recurrent_ms: recurrentRuns,
      onset_shape: result.reg_onset.dims, ...errors(result.reg_onset.data, fixture.onset),
      notes, expected_notes: fixture.notes };
  }
  if (model !== "aria") throw new Error(`Unknown model: ${model}`);
  const fixture = await (await fetch("/fixtures/aria.json")).json();
  options.externalData = [{ path: "model.onnx.data", data: "/models/aria/model.onnx.data" }];
  if (backend === "webgpu") {
    options.preferredOutputLocation = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => ["key", "value"].map((kind) =>
        [`present_${kind}_${index}`, "gpu-buffer"])).flat(),
    );
  }
  const session = await ort.InferenceSession.create("/models/aria/model.onnx", options);
  collecting = false;
  const loaded = performance.now();
  let cache = Object.fromEntries(session.inputNames.slice(1).map((name) =>
    [name, new ort.Tensor("float32", new Float32Array(0), [1, 24, 0, 64])]));
  const steps = [];
  const sequence = [...fixture.steps, ...Array.from({ length: 32 }, () => ({ tokens: fixture.steps.at(-1).tokens }))];
  for (const step of sequence) {
    const tokens = new ort.Tensor("int64", BigInt64Array.from(step.tokens.map(BigInt)), [1, step.tokens.length]);
    const runStart = performance.now();
    const output = await session.run({ tokens, ...cache });
    const duration = performance.now() - runStart;
    const comparison = step.mlx_logits ? errors(output.logits.data.slice(-step.mlx_logits.length), step.mlx_logits) : {};
    steps.push({ tokens: step.tokens.length, run_ms: duration, ...comparison });
    const previous = cache;
    cache = Object.fromEntries(session.inputNames.slice(1).map((name) =>
      [name, output[name.replace("past_", "present_")]]));
    for (const value of Object.values(previous)) value.dispose();
    output.logits.dispose();
  }
  return { model, backend, userAgent: navigator.userAgent, gpu: Boolean(adapter), ...(verbose ? { providerDiagnostics } : {}),
    cache_locations: [...new Set(Object.values(cache).map((value) => value.location))],
    load_ms: loaded - started, steps };
}

let liveSessions;
self.postMessage({ type: "ready", isolated: self.crossOriginIsolated });

async function prepareLive() {
  const options = { graphOptimizationLevel: "disabled", logSeverityLevel: 2 };
  const convolution = await ort.InferenceSession.create("/models/transcription-convolution-fp32.onnx",
    { ...options, executionProviders: ["webgpu"] });
  const recurrent = await ort.InferenceSession.create("/models/transcription-recurrent.onnx",
    { ...options, executionProviders: ["wasm"] });
  liveSessions = { convolution, recurrent };
  return { threads: ort.env.wasm.numThreads, simd: ort.env.wasm.simd, isolated: crossOriginIsolated };
}

async function listenLive(audio, threshold) {
  if (!liveSessions) throw new Error("Live inference is not initialized");
  if (audio.length !== 32000) throw new Error("Live inference requires 32000 samples");
  const { convolution, recurrent } = liveSessions;
  const intermediate = await convolution.run({ [convolution.inputNames[0]]: new ort.Tensor("float32", audio, [1, audio.length]) });
  const output = await recurrent.run(intermediate, ["reg_onset", "frame", "velocity"]);
  const notes = liveNotes(output.reg_onset.data, output.frame.data, output.velocity.data, output.reg_onset.dims[1], threshold);
  for (const value of [...Object.values(intermediate), ...Object.values(output)]) value.dispose();
  return { notes };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.wasmThreads !== undefined) {
      if (!Number.isInteger(data.wasmThreads) || data.wasmThreads < 1 || data.wasmThreads > navigator.hardwareConcurrency) throw new Error("Invalid WASM thread limit");
      ort.env.wasm.numThreads = data.wasmThreads;
    }
    const value = data.action === "prepare" ? await prepareLive()
      : data.action === "listen" ? await listenLive(data.audio, data.threshold)
      : await measure(data.model, data.backend, data.verbose);
    self.postMessage({ id: data.id, value });
  } catch (error) {
    self.postMessage({ id: data.id, error: `${error.name}: ${error.message}\n${error.stack}` });
  }
};
