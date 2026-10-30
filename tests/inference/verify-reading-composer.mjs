import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";

const stageId = process.argv[2] ?? "pairs";
const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.reading_curriculum import reading_progress
from piano_duet.reading_stages import STAGES
stage = next(item for item in STAGES if item["id"] == sys.argv[1])
progress = reading_progress([])
progress["curriculum"].update(target=stage["id"], target_number=stage["number"])
print(json.dumps(progress))
`, stageId], { encoding: "utf8" });
assert.equal(reference.status, 0, reference.stderr);
const progress = JSON.parse(reference.stdout);
const server = await startServer();
const profile = await mkdtemp(join(tmpdir(), "piano-duet-composer-"));
const browser = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true });
const page = await browser.newPage();
const files = [];
for (const [role, name] of [["graph", "model.onnx"], ["weights", "model.onnx.data"]]) {
  const path = `.cache/models/aria/onnx-int4-block64/${name}`;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  files.push({ model: "aria", role, name, revision: "local-fixture",
    url: `http://127.0.0.1:${server.address().port}/models/local-fixture/${name}`,
    sha256: hash.digest("hex"), bytes: (await stat(path)).size });
}
await page.goto("http://127.0.0.1:5173/test/composer.html");
await page.waitForFunction(() => typeof window.composeWithAria === "function");
await page.waitForLoadState("networkidle");
const result = await page.evaluate(({ files, progress, stageId }) => window.composeWithAria(files, progress, stageId), { files, progress, stageId });
assert.equal(result.provider, "webgpu");
assert.equal(result.score.reading.stage_id, stageId);
assert.ok(result.score.target.length >= 4);
assert.ok(result.score.target.every((note) => note.pitch >= 21 && note.pitch <= 108 && note.duration > 0));
assert.deepEqual(result.score.target, [...result.score.target].sort((a, b) => a.start - b.start || a.pitch - b.pitch));
console.log(JSON.stringify({ provider: result.provider, stage: stageId, notes: result.score.target.length, elapsedMs: result.elapsedMs }));
await browser.close();
await rm(profile, { recursive: true, force: true });
await new Promise((resolve) => server.close(resolve));
