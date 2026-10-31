type Streams = Record<string, number[]>;
type WrittenNote = { pitch: number; offset: number; duration: number; accidental: number; voice: number; hand: number;
  grace: boolean; trill: boolean; staccato: boolean; stem: number; tieStart?: boolean; tieStop?: boolean };
type Measure = { ticks: number; key?: number; notes: WrittenNote[] };

export function scoreMusicXml(streams: Streams): string {
  const limits: Record<string, number> = { offset: 145, downbeat: 146, duration: 97, pitch: 128, accidental: 7,
    keysignature: 16, velocity: 8, grace: 2, trill: 2, staccato: 2, voice: 9, stem: 4, hand: 3, pad: 2 };
  const count = streams.pad?.length;
  if (!count || Object.entries(limits).some(([name, limit]) => streams[name]?.length !== count
      || streams[name].some((value) => !Number.isInteger(value) || value < 0 || value >= limit))) throw new Error("Invalid score token streams");
  const indices = streams.pad.flatMap((pad, index) => pad ? [index] : []);
  if (!indices.length) throw new Error("No score notes were generated");
  const sharp = indices.filter((index) => streams.accidental[index] === 3).length;
  const flat = indices.filter((index) => streams.accidental[index] === 1).length;
  const sign = sharp > flat ? 1 : -1;
  const keys = indices.map((index) => {
    const fifths = streams.keysignature[index] - 7, twin = fifths + 12 * sign;
    return Math.sign(fifths) === -sign && Math.abs(twin) <= 7 ? twin : fifths;
  });
  const bars: Measure[] = [];
  let notes: WrittenNote[] = [], lastTicks = 96, key: number | undefined, lastKey: number | undefined;
  for (let position = 0; position < indices.length; position++) {
    const index = indices[position], previous = indices[position - 1], next = indices[position + 1];
    if (position > 0 && position + 1 < indices.length && streams.downbeat[index] > 0
        && !(streams.downbeat[next] > 0 && streams.offset[previous] !== 0 && streams.offset[next] <= streams.offset[index])) {
      lastTicks = streams.downbeat[index] - 1 || lastTicks;
      bars.push({ ticks: lastTicks, key, notes });
      notes = []; key = undefined;
    }
    if (lastKey !== keys[position]) { key ??= keys[position]; lastKey = keys[position]; }
    notes.push({ pitch: streams.pitch[index], offset: streams.offset[index], duration: streams.duration[index],
      accidental: streams.accidental[index], voice: Math.max(1, streams.voice[index]), hand: streams.hand[index] === 1 ? 1 : 0,
      grace: streams.grace[index] === 1 || streams.duration[index] === 0, trill: streams.trill[index] === 1,
      staccato: streams.staccato[index] === 1, stem: streams.stem[index] });
  }
  bars.push({ ticks: lastTicks, key, notes });
  for (const bar of bars) {
    const hands = [new Set<number>(), new Set<number>()];
    for (const hand of [0, 1]) {
      const used = hands[hand], tracks = new Map<number, WrittenNote[]>();
      for (const note of bar.notes.filter((item) => item.hand === hand)) {
        const preferred = note.voice - 1;
        const candidates = Array.from({ length: 16 }, (_, index) => index)
          .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || b - a);
        let free: number | undefined, chosen: number | undefined;
        for (const candidate of candidates) {
          if (hand === 1 && hands[0].has(candidate)) continue;
          if (used.has(candidate)) {
            if (tracks.get(candidate)!.every((other) => other.offset + other.duration <= note.offset)) { chosen = candidate; break; }
          } else if (free === undefined) free = candidate;
        }
        const voice = chosen ?? free ?? preferred;
        note.voice = voice;
        used.add(voice);
        const track = tracks.get(voice) ?? []; track.push(note); tracks.set(voice, track);
      }
    }
  }
  for (const bar of bars) {
    const unique = new Map<string, WrittenNote>();
    for (const note of [...bar.notes].sort((a, b) => a.hand - b.hand || a.voice - b.voice)) {
      const key = `${note.offset}:${note.pitch}:${note.grace}`, prior = unique.get(key);
      if (!prior || note.duration > prior.duration) unique.set(key, note);
    }
    const keep = new Set(unique.values());
    bar.notes = bar.notes.filter((note) => keep.has(note));
  }
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    for (const note of [...bar.notes]) {
      const available = bar.ticks - note.offset;
      if (available <= 0) {
        const next = bars[index + 1] ?? { ticks: bar.ticks, notes: [] };
        if (!bars[index + 1]) bars.push(next);
        bar.notes.splice(bar.notes.indexOf(note), 1);
        next.notes.push({ ...note, offset: note.offset - bar.ticks });
        continue;
      }
      if (note.grace || note.duration <= available) continue;
      const next = bars[index + 1] ?? { ticks: bar.ticks, notes: [] };
      if (!bars[index + 1]) bars.push(next);
      const rest = { ...note, offset: 0, duration: note.duration - available, tieStop: true, tieStart: false };
      note.duration = available; note.tieStart = true;
      next.notes.push(rest);
    }
  }
  const part = (hand: number) => bars.map((bar, index) => measureXml(bar, index, hand, bars[index - 1])).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Treble</part-name></score-part><score-part id="P2"><part-name>Bass</part-name></score-part></part-list><part id="P1">${part(0)}</part><part id="P2">${part(1)}</part></score-partwise>`;
}

function measureXml(bar: Measure, number: number, hand: number, previous?: Measure): string {
  const denominator = [1, 2, 4, 8, 16].reduce((best, value) => Math.abs(Math.round(bar.ticks * value / 96) / value - bar.ticks / 96)
    < Math.abs(Math.round(bar.ticks * best / 96) / best - bar.ticks / 96) ? value : best);
  const numerator = Math.max(1, Math.round(bar.ticks * denominator / 96));
  const beats = denominator <= 2 ? numerator * 4 : numerator, beatType = denominator === 1 ? 4 : denominator === 2 ? 8 : denominator;
  const attributes = `<attributes><divisions>24</divisions>${bar.key === undefined ? "" : `<key><fifths>${bar.key}</fifths></key>`}${previous?.ticks === bar.ticks ? "" : `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`}${number ? "" : `<clef><sign>${hand ? "F" : "G"}</sign><line>${hand ? 4 : 2}</line></clef>`}</attributes>`;
  const selected = bar.notes.filter((note) => note.hand === hand).sort((a, b) => a.offset - b.offset || a.pitch - b.pitch);
  const groups = new Map<string, WrittenNote[]>();
  for (const note of selected) {
    const key = `${note.offset}:${note.duration}:${note.grace}`, group = groups.get(key) ?? [];
    group.push(note); groups.set(key, group);
  }
  const voices = new Map<number, WrittenNote[][]>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.voice - b.voice);
    const key = group[0].voice, list = voices.get(key) ?? [];
    list.push(group); voices.set(key, list);
  }
  const active = [...voices].sort(([a], [b]) => a - b).map(([, groups]) => groups);
  if (!active.length) active.push([]);
  let body = "";
  for (const [index, voice] of active.entries()) {
    if (index) body += `<backup><duration>${bar.ticks}</duration></backup>`;
    let cursor = 0;
    for (const group of voice) {
      const note = group[0], gap = note.offset - cursor;
      if (gap > 0) body += restXml(gap, index + 1);
      if (gap < 0) body += `<backup><duration>${-gap}</duration></backup>`;
      body += groupXml(group, index + 1);
      cursor = note.offset + (note.grace ? 0 : note.duration);
    }
    if (cursor < bar.ticks) body += restXml(bar.ticks - cursor, index + 1);
  }
  return `<measure number="${number + 1}">${attributes}${body}</measure>`;
}

const types: [number, string, boolean, boolean][] = [[96, "whole", false, false], [72, "half", true, false],
    [48, "half", false, false], [36, "quarter", true, false], [24, "quarter", false, false],
    [18, "eighth", true, false], [16, "quarter", false, true], [12, "eighth", false, false],
    [9, "16th", true, false], [8, "eighth", false, true], [6, "16th", false, false],
    [4, "16th", false, true], [3, "32nd", false, false], [2, "32nd", false, true], [1, "64th", false, true]];

function restXml(ticks: number, voice: number): string {
  let remaining = ticks, result = "";
  while (remaining > 0) {
    const item = types.find(([duration]) => duration <= remaining);
    if (!item) throw new Error("Unsupported rest duration");
    const [duration, type, dot, triplet] = item;
    remaining -= duration;
    result += `<note><rest/><duration>${duration}</duration><voice>${voice}</voice><type>${type}</type>${dot ? "<dot/>" : ""}${triplet ? "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" : ""}</note>`;
  }
  return result;
}

function groupXml(notes: WrittenNote[], voice: number): string {
  const note = notes[0];
  if (note.grace) return notes.map((item, index) => noteXml(item, voice, "eighth", false, false, index > 0)).join("");
  let remaining = note.duration, first = true, result = "";
  while (remaining > 0) {
    const item = types.find(([ticks]) => ticks <= remaining);
    if (!item) throw new Error("Unsupported score duration");
    const [duration, type, dot, triplet] = item;
    remaining -= duration;
    result += notes.map((item, index) => noteXml({ ...item, duration, tieStop: item.tieStop || !first,
      tieStart: item.tieStart || remaining > 0 }, voice, type, dot, triplet, index > 0)).join("");
    first = false;
  }
  return result;
}

function noteXml(note: WrittenNote, voice: number, type: string, dot: boolean, triplet: boolean, chord: boolean): string {
  const alteration = note.accidental === 1 ? -1 : note.accidental === 3 ? 1 : 0;
  let natural = note.pitch - alteration;
  const names: Record<number, string> = { 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" };
  const pitchClass = (value: number) => ((value % 12) + 12) % 12;
  if (!(pitchClass(natural) in names)) natural = note.pitch - 1;
  const change = note.pitch - natural, pitch = `<pitch><step>${names[pitchClass(natural)]}</step>${change ? `<alter>${change}</alter>` : ""}<octave>${Math.floor(natural / 12) - 1}</octave></pitch>`;
  const ties = `${note.tieStop ? '<tie type="stop"/>' : ""}${note.tieStart ? '<tie type="start"/>' : ""}`;
  const notations = note.trill || note.staccato || ties ? `<notations>${note.tieStop ? '<tied type="stop"/>' : ""}${note.tieStart ? '<tied type="start"/>' : ""}${note.trill ? "<ornaments><trill-mark/></ornaments>" : ""}${note.staccato ? "<articulations><staccato/></articulations>" : ""}</notations>` : "";
  return `<note>${chord ? "<chord/>" : ""}${note.grace ? "<grace/>" : ""}${pitch}${note.grace ? "" : `<duration>${note.duration}</duration>`}${ties}<voice>${voice}</voice><type>${type}</type>${dot ? "<dot/>" : ""}${triplet ? "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" : ""}<stem>${note.stem === 1 ? "down" : "up"}</stem>${notations}</note>`;
}
