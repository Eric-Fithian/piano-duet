import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { READING_STAGES } from "../../src/core/reading-stages.ts";

test("reading stages contain the complete Python curriculum", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", "import json; from piano_duet.reading_stages import STAGES; print(json.dumps(STAGES))"], { encoding: "utf8", timeout: 300_000 });
  assert.equal(reference.status, 0, reference.stderr);
  assert.deepEqual(READING_STAGES, JSON.parse(reference.stdout));
});
