import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeContext } from "../../src/core/aria-tokenizer.ts";
import type { ContextNote } from "../../src/core/aria-tokenizer.ts";
import { DuetDecoder, generateDuet } from "../../src/core/duet-decoder.ts";
import { estimateBeat, PhraseEnding } from "../../src/core/phrase-ending.ts";

type Fixture = { level: number; seconds: number; tonic: number; scale: number[]; prompt: ContextNote[]; promptTokens: number[];
  choices: { options: [number, number][]; selected: number }[]; notes: (ContextNote | null)[] };
const fixtures: Fixture[] = JSON.parse(readFileSync("tests/fixtures/duet-sampling.json", "utf8"));
const expand = (ranges: [number, number][]) => ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, index) => start + index));

test("Duet decoder replays Python's allowed tokens and notes", () => {
  for (const fixture of fixtures) {
    const context = encodeContext({ notes: fixture.prompt, end: Math.max(...fixture.prompt.map((note) => note.start)) });
    assert.deepEqual(context.tokens, fixture.promptTokens);
    const ending = new PhraseEnding(fixture.seconds, estimateBeat(fixture.prompt), fixture.tonic, fixture.scale);
    const decoder = new DuetDecoder(context, ending, fixture.level, fixture.scale);
    const notes: (ContextNote | null)[] = [];
    for (const choice of fixture.choices) {
      assert.deepEqual(decoder.options(), expand(choice.options));
      const note = decoder.accept(choice.selected);
      if (note) notes.push(note);
      if (decoder.modelEnded) notes.push(null);
    }
    assert.deepEqual(notes, fixture.notes);
    assert.equal(decoder.done, true);
  }
});

test("Duet streams complete phrase boundaries while sampling the same masks", async () => {
  for (const fixture of fixtures) {
    let choiceIndex = 0, calls = 0;
    const session = { async run(input: { tokens: number[]; reset: boolean }) {
      assert.equal(input.reset, calls === 0);
      if (calls++ === 0) assert.deepEqual(input.tokens, fixture.promptTokens);
      else assert.deepEqual(input.tokens, [fixture.choices[choiceIndex - 1].selected]);
      return { logits: new Float32Array(17727) };
    } };
    const random = { choices(options: number[]) {
      const choice = fixture.choices[choiceIndex++];
      assert.deepEqual(options, expand(choice.options));
      return [choice.selected];
    } };
    const generated: ContextNote[] = [];
    for await (const note of generateDuet(session, random, fixture.prompt, {
      seconds: fixture.seconds, temperature: 1, difficulty: fixture.level, tonic: fixture.tonic, pitchClasses: fixture.scale,
    })) generated.push(note);
    const ending = new PhraseEnding(fixture.seconds, estimateBeat(fixture.prompt), fixture.tonic, fixture.scale);
    const expected: ContextNote[] = [];
    for (const note of fixture.notes) {
      if (note === null) { expected.push(...ending.finish(true)); break; }
      expected.push(...ending.feed(note));
      if (ending.done) break;
    }
    expected.push(...ending.finish());
    assert.deepEqual(generated, expected);
  }
});

test("stopping a reply cancels an in-flight model call", async () => {
  const abort = new AbortController();
  const session = { async run(_input: unknown, signal?: AbortSignal): Promise<{ logits: Float32Array }> {
    assert.equal(signal, abort.signal);
    return new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      abort.abort();
    });
  } };
  const reply = generateDuet(session, { choices: () => { throw new Error("Cancelled replies must not sample"); } }, fixtures[0].prompt,
    { seconds: 2, temperature: 0.95, difficulty: 1, tonic: 0, pitchClasses: fixtures[0].scale, signal: abort.signal });
  await assert.rejects(reply.next(), { name: "AbortError" });
});
