import { strToU8, zipSync } from "fflate";
import { MXL_LIMITS, parseMxl, unzipMusicXml } from "../../../src/core/score-mxl.ts";
import { parseMusicXml } from "../../../src/core/score-xml.ts";

function errorMessage(run: () => unknown): string {
  try { run(); } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("An invalid score was accepted");
}

Object.assign(window, { inspectScoreImport() {
  const score = '<score-partwise><part id="P1"><measure number="1"/></part></score-partwise>';
  const doctype = '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">';
  const container = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>';
  const archive = zipSync({ "META-INF/container.xml": strToU8(container), "score.musicxml": strToU8(score) });
  const files = Object.fromEntries(Array.from({ length: MXL_LIMITS.entries + 1 }, (_, index) => [`file-${index}`, new Uint8Array([1])]));
  return { normal: parseMusicXml(strToU8(doctype + score)), archive: parseMxl(archive),
    entityError: errorMessage(() => parseMusicXml(strToU8('<!DOCTYPE score-partwise [<!ENTITY x "boom">]><score-partwise>&x;</score-partwise>'))),
    subsetError: errorMessage(() => parseMusicXml(strToU8('<!DOCTYPE score-partwise []>' + score))),
    countError: errorMessage(() => unzipMusicXml(zipSync(files))),
    sizeError: errorMessage(() => unzipMusicXml(new Uint8Array(MXL_LIMITS.archive + 1))) };
} });
