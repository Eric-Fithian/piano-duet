import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scoreMusicXml } from "../../src/core/score-output.ts";
import { parseMusicXml } from "../../src/core/score-xml.ts";

const directory = "tests/fixtures/score-writing";
const tokens = JSON.parse(readFileSync(`${directory}/tokens.json`, "utf8")) as Record<string, number[]>;

test("score tokens produce the Python reference notes, measures and parts", () => {
  const reference = parseMusicXml(readFileSync(`${directory}/reference.musicxml`));
  const actual = parseMusicXml(new TextEncoder().encode(scoreMusicXml(tokens)));
  const order = (notes: typeof actual.notes) => notes.map((note) => JSON.stringify(note)).sort();
  assert.deepEqual(order(actual.notes), order(reference.notes));
  assert.deepEqual(actual.measures, reference.measures);
  assert.deepEqual(actual.meters, reference.meters);
  assert.deepEqual(actual.key, reference.key);
  assert.ok(scoreMusicXml(tokens).includes("<trill-mark/>"));
  assert.ok(scoreMusicXml(tokens).includes("<staccato/>"));
});

test("score writing rejects malformed streams and writes common time", () => {
  assert.throws(() => scoreMusicXml({ ...tokens, pitch: [60] }), { message: "Invalid score token streams" });
  const four = { ...tokens, downbeat: tokens.downbeat.map((value) => value === 73 ? 97 : value) };
  const actual = parseMusicXml(new TextEncoder().encode(scoreMusicXml(four)));
  assert.deepEqual(actual.meters[0], [0, "4/4"]);
});

test("score key changes follow the Python notation reference", () => {
  const changing = JSON.parse(readFileSync(`${directory}/keychange.json`, "utf8")) as Record<string, number[]>;
  const reference = parseMusicXml(readFileSync(`${directory}/keychange.musicxml`));
  const actual = parseMusicXml(new TextEncoder().encode(scoreMusicXml(changing)));
  assert.deepEqual(actual.key, reference.key);
  assert.deepEqual(actual.measures, reference.measures);
  assert.deepEqual(actual.notes.map((note) => JSON.stringify(note)).sort(), reference.notes.map((note) => JSON.stringify(note)).sort());
});

test("notes extending beyond the final bar are tied into a new measure", () => {
  const ending = JSON.parse(readFileSync(`${directory}/ending.json`, "utf8")) as Record<string, number[]>;
  const reference = parseMusicXml(readFileSync(`${directory}/ending.musicxml`));
  const actual = parseMusicXml(new TextEncoder().encode(scoreMusicXml(ending)));
  assert.deepEqual(actual.measures, reference.measures);
  assert.deepEqual(actual.notes.map((note) => JSON.stringify(note)).sort(), reference.notes.map((note) => JSON.stringify(note)).sort());
});
