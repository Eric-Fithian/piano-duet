import { DOMParser } from "@xmldom/xmldom";
import { roundEven } from "./numeric.ts";
import { ScoreError } from "./score-midi.ts";

type XmlElement = NonNullable<ReturnType<typeof DOMParser.prototype.parseFromString>["documentElement"]>;
type XmlNote = { pitch: number; beat: number; length: number; velocity: number; staff: "treble" | "bass";
  voice: string; grace: boolean; tie_start: boolean; tie_stop: boolean };
const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function parseSafeXml(data: Uint8Array) {
  const encoding = data[0] === 0xff && data[1] === 0xfe || data[0] === 0x3c && data[1] === 0 && data[2] === 0x3f && data[3] === 0
    ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff || data[0] === 0 && data[1] === 0x3c && data[2] === 0 && data[3] === 0x3f
      ? "utf-16be" : "utf-8";
  const source = new TextDecoder(encoding, { fatal: true }).decode(data), upper = source.toUpperCase();
  if (upper.includes("<!ENTITY")) throw new ScoreError("MusicXML entity declarations are not supported");
  let from = 0;
  while (true) {
    const start = upper.indexOf("<!DOCTYPE", from);
    if (start < 0) break;
    let quote = "", end = -1;
    for (let index = start + 9; index < source.length; index++) {
      const character = source[index];
      if (quote) { if (character === quote) quote = ""; continue; }
      if (character === "'" || character === '"') quote = character;
      else if (character === "[") throw new ScoreError("MusicXML internal DTD subsets are not supported");
      else if (character === ">") { end = index; break; }
    }
    if (end < 0) throw new ScoreError("MusicXML has an incomplete DOCTYPE");
    from = end + 1;
  }
  return new DOMParser({ onError: (_level, message) => { throw new ScoreError(`Invalid MusicXML: ${message}`); } }).parseFromString(source, "application/xml");
}

function children(parent: XmlElement, tag: string): XmlElement[] {
  return Array.from(parent.childNodes).filter((node) => node.nodeType === 1 && (node as XmlElement).tagName === tag) as XmlElement[];
}

function child(parent: XmlElement, tag: string): XmlElement | undefined { return children(parent, tag)[0]; }
function text(parent: XmlElement | undefined, path: string[], fallback: string | null = null): string | null {
  let node = parent;
  for (const name of path) node = node && child(node, name);
  return node ? node.textContent : fallback;
}

function integer(value: string | null, label: string): number {
  if (value === null || value.trim() === "" || !Number.isInteger(Number(value))) throw new ScoreError(`Invalid ${label} in MusicXML`);
  return Number(value);
}

export function parseMusicXml(data: Uint8Array) {
  const document = parseSafeXml(data), root = document.documentElement;
  if (!root || root.tagName !== "score-partwise") throw new ScoreError("Only partwise MusicXML is supported; export the score again from MuseScore");
  const title = text(root, ["work", "work-title"]) || text(root, ["movement-title"]);
  const identification = child(root, "identification");
  const composer = identification ? children(identification, "creator").find((creator) => creator.getAttribute("type") === "composer")?.textContent ?? null : null;
  const notes: XmlNote[] = [], meters: [number, string][] = [], keys: [number, number, string | null][] = [], tempos: [number, number][] = [], measures: number[] = [];
  let pickup = 0;
  const parts = children(root, "part");
  for (const [partIndex, part] of parts.entries()) {
    let divisions = 1, measureStart = 0, staves = 1;
    for (const [measureIndex, measure] of children(part, "measure").entries()) {
      if (partIndex === 0) measures.push(measureStart);
      let cursor = measureStart, longest = measureStart, lastStart = measureStart;
      for (const node of Array.from(measure.childNodes).filter((item) => item.nodeType === 1) as XmlElement[]) {
        if (node.tagName === "attributes") {
          divisions = integer(text(node, ["divisions"], String(divisions)), "divisions");
          staves = integer(text(node, ["staves"], String(staves)), "staves");
          if (child(node, "time") && partIndex === 0) meters.push([measureStart, `${text(node, ["time", "beats"])}/${text(node, ["time", "beat-type"])}`]);
          if (child(node, "key") && partIndex === 0) keys.push([measureStart, integer(text(node, ["key", "fifths"]), "key"), text(node, ["key", "mode"])]);
        } else if (node.tagName === "sound" && node.getAttribute("tempo") && partIndex === 0) tempos.push([cursor, Number(node.getAttribute("tempo"))]);
        else if (node.tagName === "direction" && child(node, "sound")?.getAttribute("tempo") && partIndex === 0) tempos.push([cursor, Number(child(node, "sound")!.getAttribute("tempo"))]);
        else if (node.tagName === "backup" || node.tagName === "forward") {
          const step = integer(text(node, ["duration"]), "duration") / divisions;
          cursor += node.tagName === "backup" ? -step : step;
        } else if (node.tagName === "note") {
          const grace = Boolean(child(node, "grace"));
          const length = grace ? 0 : integer(text(node, ["duration"], "0"), "duration") / divisions;
          const start = child(node, "chord") ? lastStart : cursor;
          if (!child(node, "rest")) {
            const step = text(node, ["pitch", "step"]), octave = integer(text(node, ["pitch", "octave"]), "octave");
            if (!step || !(step in STEPS)) throw new ScoreError("Invalid pitch in MusicXML");
            const alter = Number(text(node, ["pitch", "alter"], "0"));
            if (!Number.isFinite(alter)) throw new ScoreError("Invalid pitch alteration in MusicXML");
            const pitch = 12 * (octave + 1) + STEPS[step] + roundEven(alter);
            const staff = integer(text(node, ["staff"], "1"), "staff");
            const hand = staves === 2 ? staff === 1 ? "treble" : "bass" : parts.length === 2 ? partIndex === 0 ? "treble" : "bass" : pitch >= 60 ? "treble" : "bass";
            const ties = children(node, "tie").map((tie) => tie.getAttribute("type"));
            notes.push({ pitch, beat: start, length, velocity: 80, staff: hand, voice: JSON.stringify([partIndex, staff, text(node, ["voice"], "1")]),
              grace, tie_start: ties.includes("start"), tie_stop: ties.includes("stop") });
          }
          lastStart = start;
          if (!child(node, "chord")) cursor = start + length;
        }
        longest = Math.max(longest, cursor);
      }
      if (measureIndex === 0 && partIndex === 0 && measure.getAttribute("implicit") === "yes") pickup = longest - measureStart;
      measureStart = longest;
    }
  }
  notes.sort((a, b) => a.beat - b.beat);
  const merged: XmlNote[] = [];
  for (const note of notes) {
    const held = note.tie_stop ? merged.findLast((item) => item.pitch === note.pitch && !item.grace && Math.abs(item.beat + item.length - note.beat) < 1e-6) : undefined;
    if (held) held.length += note.length;
    else merged.push({ ...note });
  }
  const voices = new Map<string, Map<string, number>>();
  for (const note of merged) {
    const counts = voices.get(note.staff) ?? new Map<string, number>();
    counts.set(note.voice, (counts.get(note.voice) ?? 0) + 1); voices.set(note.staff, counts);
  }
  const main = new Map([...voices].map(([staff, counts]) => [staff, [...counts].reduce((best, item) => item[1] > best[1] ? item : best)[0]]));
  const output = merged.map(({ tie_start: _start, tie_stop: _stop, voice, ...note }) => ({ ...note, voice: Number(voice !== main.get(note.staff)) }));
  meters.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  keys.sort((a, b) => a[0] - b[0] || a[1] - b[1] || String(a[2]).localeCompare(String(b[2])));
  tempos.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { notes: output, bpm: tempos.length ? roundEven(tempos[0][1]) : 72, meters,
    key: keys.length ? [keys[0][1], keys[0][2]] as [number, string | null] : null, title, composer, pickup, measures };
}
