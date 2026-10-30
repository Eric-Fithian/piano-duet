import { RecordingPool } from "../src/recording-pool";

Object.assign(window, {
  async inspectRecordingPool(base: string, count: number, threads: number) {
    const audio = new Float32Array(await (await fetch(`${base}/fixtures/recording.pcm`)).arrayBuffer());
    const features = await (await fetch(`${base}/models/local-fixture/recording-features.onnx`)).arrayBuffer();
    const attributes = await (await fetch(`${base}/models/local-fixture/recording-attributes.onnx`)).arrayBuffer();
    const pool = await RecordingPool.open(features, attributes, count, threads);
    const started = performance.now();
    const notes = await pool.run(audio, new AbortController().signal);
    const elapsedMs = performance.now() - started;
    pool.close();
    return { notes, elapsedMs, provider: "wasm" };
  },
});
