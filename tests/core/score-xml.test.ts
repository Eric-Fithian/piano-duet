import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseMusicXml } from "../../src/core/score-xml.ts";

test("MusicXML parsing matches Python for ties, voices, staves and pickups", () => {
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import json, sys
from piano_duet.score_import import parse_musicxml
sys.path.insert(0, 'tests')
from test_library import MUSICXML
two_parts = '''<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
  <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note></measure></part>
  <part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>'''
voice = '''<score-partwise><movement-title>Two voices</movement-title><identification><creator>A composer</creator></identification>
  <part id="P1"><measure number="1"><attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
  <note><grace/><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><voice>2</voice></note>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
  <note><chord/><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
  <backup><duration>4</duration></backup><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice></note>
  <forward><duration>8</duration></forward></measure></part></score-partwise>'''
sources = [MUSICXML, two_parts, voice]
print(json.dumps([{'xml': source, 'parsed': parse_musicxml(source.encode())} for source in sources]))
`], { encoding: "utf8", timeout: 300_000, maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const cases: { xml: string; parsed: unknown }[] = JSON.parse(reference.stdout);
  for (const item of cases) assert.deepEqual(parseMusicXml(new TextEncoder().encode(item.xml)), item.parsed);
});

test("MusicXML allows a normal DOCTYPE and rejects entities and internal subsets", () => {
  const encoder = new TextEncoder();
  const score = '<score-partwise><part id="P1"><measure number="1"/></part></score-partwise>';
  const doctype = '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">';
  assert.deepEqual(parseMusicXml(encoder.encode(doctype + score)), parseMusicXml(encoder.encode(score)));
  assert.throws(() => parseMusicXml(encoder.encode('<!DOCTYPE score-partwise [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;">]><score-partwise>&b;</score-partwise>')),
    { message: "MusicXML entity declarations are not supported" });
  assert.throws(() => parseMusicXml(encoder.encode('<!DOCTYPE score-partwise []>' + score)),
    { message: "MusicXML internal DTD subsets are not supported" });
  assert.throws(() => parseMusicXml(encoder.encode('<score-timewise/>')),
    { message: "Only partwise MusicXML is supported; export the score again from MuseScore" });
});
