import { Unzip, UnzipInflate } from "fflate";
import { ScoreError } from "./score-midi.ts";
import { parseMusicXml, parseSafeXml } from "./score-xml.ts";

export const MXL_LIMITS = { archive: 8_000_000, entries: 128, entry: 16_000_000, expanded: 32_000_000 };

export function unzipMusicXml(data: Uint8Array): Uint8Array {
  if (!data.length || data.length > MXL_LIMITS.archive) throw new ScoreError("Import a score file under 8 MB");
  const entries = new Map<string, Uint8Array[]>(), sizes = new Map<string, number>(), finished = new Set<string>();
  let expanded = 0;
  const unzip = new Unzip((file) => {
    if (entries.size >= MXL_LIMITS.entries) throw new ScoreError("The MXL archive has too many entries");
    if (entries.has(file.name)) throw new ScoreError("The MXL archive has duplicate entries");
    if (file.originalSize !== undefined && file.originalSize > MXL_LIMITS.entry) throw new ScoreError("An MXL entry is too large");
    entries.set(file.name, []); sizes.set(file.name, 0);
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      if (!chunk) throw new ScoreError("The MXL archive returned no entry data");
      const size = sizes.get(file.name)! + chunk.length;
      expanded += chunk.length;
      if (size > MXL_LIMITS.entry || expanded > MXL_LIMITS.expanded) throw new ScoreError("The MXL archive expands beyond its size limit");
      sizes.set(file.name, size);
      entries.get(file.name)!.push(chunk);
      if (final) finished.add(file.name);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try { for (let at = 0; at < data.length; at += 1024) unzip.push(data.subarray(at, at + 1024), at + 1024 >= data.length); }
  catch (error) {
    if (error instanceof ScoreError) throw error;
    if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === "number") throw new ScoreError(`Invalid MXL archive: ${error.message}`);
    throw error;
  }
  if (finished.size !== entries.size) throw new ScoreError("The MXL archive is incomplete");
  const read = (name: string) => {
    const chunks = entries.get(name), size = sizes.get(name);
    if (!chunks || size === undefined) throw new ScoreError(`The MXL archive is missing ${name}`);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  };
  const container = parseSafeXml(read("META-INF/container.xml"));
  const rootfile = Array.from(container.getElementsByTagNameNS("*", "rootfile"))[0];
  const path = rootfile?.getAttribute("full-path");
  if (!path) throw new ScoreError("The MXL archive has no score path");
  return read(path);
}

export function parseMxl(data: Uint8Array) {
  return parseMusicXml(unzipMusicXml(data));
}
