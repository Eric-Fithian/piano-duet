import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { decodeRecordingIntervals } from "../../src/core/recording-intervals.ts";

test("recording interval paths match Transkun's backward decoder", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, torch
from transkun.CRF.NeuralSemiCRFInterval import viterbiBackward
cases = []
for seed in range(20):
    generator = torch.Generator().manual_seed(seed)
    frames, tracks = 3 + seed % 13, 1 + seed % 6
    score = torch.randn((frames, frames, tracks), generator=generator)
    skip = torch.randn((frames - 1, tracks), generator=generator)
    if seed % 5 == 0:
        score.fill_(0)
        skip.fill_(0)
    starts = [(seed + index * 3) % frames for index in range(tracks)]
    cases.append({"frames": frames, "tracks": tracks, "score": score.flatten().tolist(), "skip": skip.flatten().tolist(),
        "starts": starts, "paths": viterbiBackward(score, skip, starts)})
print(json.dumps(cases))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 2_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { frames: number; tracks: number; score: number[]; skip: number[]; starts: number[]; paths: [number, number][][] }[] = JSON.parse(reference.stdout);
  for (const item of cases) assert.deepEqual(decodeRecordingIntervals(Float32Array.from(item.score), Float32Array.from(item.skip),
    item.frames, item.tracks, item.starts), item.paths);
  assert.throws(() => decodeRecordingIntervals(new Float32Array(1), new Float32Array(1), 2, 1, [0]),
    (error: unknown) => error instanceof Error && error.message === "Invalid recording interval scores");
});
