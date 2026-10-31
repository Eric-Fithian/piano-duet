import * as ort from "onnxruntime-web/webgpu";
import { ScoreRuntime } from "../src/score-runtime";
import type { ScoreProgress } from "../src/score-runtime";

Object.assign(window, {
  async verifyScoreProgress() {
    const encoder = { async run() { return { encoded: new ort.Tensor("float32", new Float32Array(1), [1, 1]) }; }, async release() {} };
    const decoder = { async run(_input: unknown, fetches: string[]) {
      return Object.fromEntries(fetches.map((name) => [name, new ort.Tensor("float32", new Float32Array(name === "out_pad" ? 1 : 160),
        [1, name === "out_pad" ? 1 : 160])]));
    }, async release() {} };
    const Runtime = ScoreRuntime as unknown as new (...sessions: unknown[]) => ScoreRuntime;
    const runtime = new Runtime(encoder, decoder, decoder, decoder), progress: ScoreProgress[] = [];
    const tokens = await runtime.generate({ onset: [0], duration: [0], pitch: [60], velocity: [0], pad: [1] }, undefined, undefined,
      (value) => progress.push(value));
    await runtime.close();
    return { progress, tokenCount: tokens.pad.length };
  },
});
