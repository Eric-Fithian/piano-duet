import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { KeyTracker } from "../../src/core/key-tracker.ts";
import type { KeyNote } from "../../src/core/key-tracker.ts";

test("key tracking matches Python across synthetic performances", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, random
from piano_duet.key_tracking import KeyTracker
from piano_duet.notes import Note
rng = random.Random(12)
tracker = KeyTracker()
cases = []
for index in range(100):
    notes = [Note(pitch=rng.randrange(48, 85), start=i / 4, duration=rng.uniform(.05, 2), velocity=rng.randrange(30, 128)) for i in range(index % 17 + 1)]
    cases.append({'notes': [n.model_dump() for n in notes], 'key': tracker.observe(notes)})
print(json.dumps(cases))
`], { encoding: "utf8", maxBuffer: 3_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { notes: KeyNote[]; key: unknown }[] = JSON.parse(reference.stdout);
  const tracker = new KeyTracker();
  for (const item of cases) assert.deepEqual(tracker.observe(item.notes), item.key);
});
