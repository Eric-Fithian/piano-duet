import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { barRhythms, beatGroups, figures, nextValues, restPositions } from "../../src/core/reading-rhythm.ts";

test("reading rhythm grammar matches Python for meters, figures and rests", () => {
  const cases = [];
  for (const meter of ["2/4", "3/4", "4/4", "6/8", "7/8", "9/8", "12/8"]) {
    for (const style of ["held", "long", "quarters", "eighths", "dotted", "syncopation", "sixteenths", "triplets", "mixed"]) {
      for (const ending of style === "long" ? [0] : [0, 1]) {
        for (const restAt of style === "long" ? [null] : [null, 1]) {
          for (const figure of [false, true]) cases.push({ meter, style, ending, restAt, figure });
        }
      }
    }
  }
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.reading_music import bar_rhythms, beat_groups, figures, rest_positions
cases = json.loads(sys.stdin.readline())
print(json.dumps([{"groups": beat_groups(c["meter"]), "figures": figures(c["style"], c["meter"]), "rests": rest_positions(c["style"], c["meter"], c["ending"]), "rhythms": bar_rhythms(c["style"], c["meter"], c["restAt"], c["ending"], c["figure"])} for c in cases]))
`], { input: JSON.stringify(cases) + "\n", encoding: "utf8", timeout: 300_000, maxBuffer: 20_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  cases.forEach((item, index) => {
    assert.deepEqual({ groups: beatGroups(item.meter), figures: figures(item.style, item.meter),
      rests: restPositions(item.style, item.meter, item.ending), rhythms: barRhythms(item.style, item.meter, item.restAt, item.ending, item.figure) }, expected[index], JSON.stringify(item));
  });
  assert.deepEqual(nextValues([[1, 0.5, 0.5], [1, 1], [0.5, 0.5, 1]], [1]), [0.5, 1]);
});
