import { BrowserInference } from "../src/browser-inference";
import type { ModelAsset } from "../src/browser-inference";

Object.assign(window, {
  async transcribePhraseFixture(files: ModelAsset[], audioUrl: string, preference: "auto" | "wasm") {
    const backend = new BrowserInference({ "phrase-transcription": files }, preference);
    const response = await fetch(audioUrl);
    if (!response.ok) throw new Error(`Could not fetch the phrase: ${response.status}`);
    const audio = new Float32Array(await response.arrayBuffer());
    const session = await backend.createSession("phrase-transcription", () => {});
    const started = performance.now();
    const result = await session.run({ audio, sampleRate: 16000, threshold: 0.8 });
    const elapsedMs = performance.now() - started, provider = session.provider;
    await session.close();
    return { ...result, elapsedMs, provider };
  },
});
