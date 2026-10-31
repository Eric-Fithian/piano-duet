import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PerformanceLimits } from "../../src/core/performance-limits.ts";

test("reply difficulty windows match Python for changing chords and hand positions", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, random
from piano_duet.difficulty import PerformanceLimits
rng = random.Random(719)
cases = []
for level in range(1, 6):
    for beat in (0.3, 0.5, 0.83, 1.0):
        limits = PerformanceLimits(level, beat)
        records = []
        onset = 0
        for index in range(35):
            earliest = onset + rng.choice((0, 20, 40, 80, 250))
            windows = [limits.windows(pitch, earliest) for pitch in range(21, 109)]
            windows = [[[start, None if end == float('inf') else end] for start, end in entries] for entries in windows]
            pitch = rng.randrange(21, 109)
            onset += rng.choice((0, 10, 40, 80, 300))
            records.append({'earliest': earliest, 'windows': windows, 'pitch': pitch, 'onset': onset})
            limits.record(pitch, onset)
        cases.append({'level': level, 'beat': beat, 'gap': limits.gap, 'floor': limits.duration_floor, 'records': records})
print(json.dumps(cases))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { level: number; beat: number; gap: number; floor: number; records: { earliest: number; windows: (number | null)[][][]; pitch: number; onset: number }[] }[] = JSON.parse(reference.stdout);
  for (const item of cases) {
    const limits = new PerformanceLimits(item.level, item.beat);
    assert.equal(limits.gap, item.gap);
    assert.equal(limits.durationFloor, item.floor);
    for (const record of item.records) {
      const windows = Array.from({ length: 88 }, (_, index) => limits.windows(index + 21, record.earliest).map(([start, end]) => [start, Number.isFinite(end) ? end : null]));
      assert.deepEqual(windows, record.windows);
      limits.record(record.pitch, record.onset);
    }
  }
});
