import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODEL_CATALOG } from "../../site/app/src/model-catalog.ts";

const selected = process.argv.slice(2);
if (selected.some((model) => !(model in MODEL_CATALOG))) throw new Error("Unknown model in download request");
const files = Object.entries(MODEL_CATALOG).filter(([model]) => !selected.length || selected.includes(model)).flatMap(([, assets]) => assets);
for (const file of files) {
  const path = `.cache/ci-models/${file.model}/${file.name}`;
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path) && await valid(path, file)) { console.log(`Cached ${file.model}/${file.name}`); continue; }
  const response = await fetch(file.url);
  if (!response.ok || !response.body) throw new Error(`Could not download ${file.model}/${file.name}: HTTP ${response.status}`);
  const partial = `${path}.partial`;
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      hash.update(chunk);
      done(null, chunk);
    } }), createWriteStream(partial));
    if (size !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error(`Integrity check failed for ${file.model}/${file.name}`);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  console.log(`Downloaded ${file.model}/${file.name} (${size} bytes)`);
}

async function valid(path, file) {
  if ((await stat(path)).size !== file.bytes) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex") === file.sha256;
}
