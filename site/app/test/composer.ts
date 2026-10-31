import { AriaPhrase } from "../../../src/core/aria-phrase.ts";
import type { PhraseContext } from "../../../src/core/aria-tokenizer.ts";
import { composeReading } from "../../../src/core/reading-composer.ts";
import type { ComposerProgress } from "../../../src/core/reading-composer.ts";
import { RandomSource } from "../../../src/core/random.ts";
import { READING_STAGES } from "../../../src/core/reading-stages.ts";
import { BrowserInference } from "../src/browser-inference";
import type { ModelAsset } from "../src/browser-inference";

Object.assign(window, {
  async composeWithAria(files: ModelAsset[], progress: ComposerProgress, stageId: string) {
    const stage = READING_STAGES.find((item) => item.id === stageId);
    if (!stage) throw new Error(`Unknown stage ${stageId}`);
    const backend = new BrowserInference({ aria: files });
    const session = await backend.createSession("aria", () => {});
    let state = 17;
    const rng = new RandomSource(() => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; });
    const start = performance.now();
    const score = await composeReading(stage, progress, rng, (context) => new AriaPhrase(session, rng, context as PhraseContext | null));
    const result = { score, provider: session.provider, elapsedMs: performance.now() - start };
    await session.close();
    return result;
  },
});
