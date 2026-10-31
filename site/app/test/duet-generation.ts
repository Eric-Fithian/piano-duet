import { generateDuet } from "../../../src/core/duet-decoder.ts";
import { RandomSource } from "../../../src/core/random.ts";
import { BrowserInference } from "../src/browser-inference";
import type { ModelAsset } from "../src/browser-inference";

Object.assign(window, {
  async generateDuetFixture(files: ModelAsset[]) {
    const backend = new BrowserInference({ aria: files });
    const session = await backend.createSession("aria", () => {});
    const input = [
      { pitch: 60, start: 0, duration: 0.4, velocity: 80 },
      { pitch: 64, start: 0.5, duration: 0.4, velocity: 80 },
      { pitch: 67, start: 1, duration: 0.4, velocity: 80 },
      { pitch: 72, start: 1.5, duration: 0.5, velocity: 80 },
    ];
    const scale = [0, 2, 4, 5, 7, 9, 11];
    const started = performance.now();
    const reply = [];
    for await (const note of generateDuet(session, new RandomSource(), input,
      { seconds: 2, temperature: 0.95, difficulty: 3, tonic: 0, pitchClasses: scale, maxNotes: 24 })) reply.push(note);
    const elapsedMs = performance.now() - started;
    const provider = session.provider;
    await session.close();
    return { provider, reply, elapsedMs };
  },
});
