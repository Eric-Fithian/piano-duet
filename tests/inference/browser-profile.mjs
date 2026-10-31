import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function browserProfile() {
  const disk = await statfs("/", { bigint: true });
  const available = disk.bavail * disk.bsize;
  const minimum = 3n * 1024n ** 3n + 1500000000n;
  if (available < minimum) throw new Error(`Model browser tests need 1.5 GB of scratch space and 3 GiB free afterwards; ${available} bytes are available`);
  const shared = process.env.PIANO_BROWSER_PROFILE;
  const path = shared ? resolve(shared) : await mkdtemp(join(tmpdir(), "piano-duet-model-"));
  if (shared) await mkdir(path, { recursive: true });
  return { path, async cleanup() { if (!shared) await rm(path, { recursive: true, force: true }); } };
}
