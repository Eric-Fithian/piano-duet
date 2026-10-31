import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { MXL_LIMITS, parseMxl, unzipMusicXml } from "../../src/core/score-mxl.ts";
import { parseMusicXml } from "../../src/core/score-xml.ts";

const CONTAINER = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>';
const SCORE = '<score-partwise><part id="P1"><measure number="1"/></part></score-partwise>';

test("MXL reads the named MusicXML score", () => {
  const archive = zipSync({ "META-INF/container.xml": strToU8(CONTAINER), "score.musicxml": strToU8(SCORE) });
  assert.deepEqual(parseMxl(archive), parseMusicXml(strToU8(SCORE)));
  const entities = zipSync({ "META-INF/container.xml": strToU8(CONTAINER),
    "score.musicxml": strToU8('<!DOCTYPE score-partwise [<!ENTITY x "boom">]><score-partwise>&x;</score-partwise>') });
  assert.throws(() => parseMxl(entities), { message: "MusicXML entity declarations are not supported" });
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import base64, io, json, sys, zipfile
from piano_duet.score_import import parse_score
sys.path.insert(0, 'tests')
from test_library import MUSICXML
output = io.BytesIO()
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('META-INF/container.xml', '${CONTAINER}')
    archive.writestr('score.musicxml', MUSICXML)
data = output.getvalue()
print(json.dumps({'archive': base64.b64encode(data).decode(), 'score': parse_score('score.mxl', data)}))
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const python = JSON.parse(reference.stdout);
  assert.deepEqual(parseMxl(Buffer.from(python.archive, "base64")), python.score);
});

test("MXL enforces archive, entry count and decompressed size limits", () => {
  assert.throws(() => unzipMusicXml(new Uint8Array(MXL_LIMITS.archive + 1)), { message: "Import a score file under 8 MB" });
  const files = Object.fromEntries(Array.from({ length: MXL_LIMITS.entries + 1 }, (_, index) => [`file-${index}`, new Uint8Array([1])]));
  assert.throws(() => unzipMusicXml(zipSync(files)), { message: "The MXL archive has too many entries" });
  const bomb = zipSync({ "bomb.xml": new Uint8Array(MXL_LIMITS.entry + 1) }, { level: 9 });
  assert.throws(() => unzipMusicXml(bomb), { message: "An MXL entry is too large" });
  new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength).setUint32(22, 1, true);
  assert.throws(() => unzipMusicXml(bomb), { message: "The MXL archive expands beyond its size limit" });
  const manyLarge = zipSync({ one: new Uint8Array(12_000_000), two: new Uint8Array(12_000_000), three: new Uint8Array(12_000_000) }, { level: 9 });
  assert.throws(() => unzipMusicXml(manyLarge), { message: "The MXL archive expands beyond its size limit" });
});
