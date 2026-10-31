import type { MusicalKey } from "./musical-key.ts";
import { median, roundDecimal, roundEven } from "./numeric.ts";

export type DrillNote = { pitch: number; start: number; velocity: number; hand?: string; finger?: number | null; accent?: boolean };
type Alignment = { expected: number[]; played: number[] }[];
type Attack = { index: number; expected: number; played: number | null; velocity: number | null; missed: number[]; extra: number[];
  inserted: number[][]; pitches: number[]; bar: number; ratio?: number | null; tempo?: number | null; deviation_ms?: number; flag?: string };
const LOCAL = 4;

export function matchDrillNotes(raw: DrillNote[], notes: DrillNote[], alignment: Alignment): Map<number, number> {
  const matched = new Map<number, number>();
  for (const group of alignment) {
    const available = [...group.played];
    for (const index of group.expected) {
      const position = available.findIndex((played) => notes[played].pitch === raw[index].pitch);
      if (position >= 0) matched.set(index, available.splice(position, 1)[0]);
    }
  }
  return matched;
}

export function drillTiming(raw: DrillNote[], notes: DrillNote[], matched: Map<number, number>, alignment: Alignment, bpm: number, key: MusicalKey) {
  const attacks: Attack[] = [], used = new Set(matched.values());
  let inserted: number[][] = [];
  for (const group of alignment) {
    if (!group.expected.length) {
      inserted.push([...new Set(group.played.map((index) => notes[index].pitch))].sort((a, b) => a - b));
      continue;
    }
    const top = group.expected.reduce((a, b) => raw[b].pitch > raw[a].pitch ? b : a);
    const heard = group.expected.filter((index) => matched.has(index)).map((index) => notes[matched.get(index)!]);
    attacks.push({ index: top, expected: raw[top].start, played: heard.length ? Math.min(...heard.map((note) => note.start)) : null,
      velocity: heard.length ? roundEven(median(heard.map((note) => note.velocity))) : null,
      missed: group.expected.filter((index) => !matched.has(index)).map((index) => raw[index].pitch),
      extra: [...new Set(group.played.filter((index) => !used.has(index)).map((index) => notes[index].pitch))].sort((a, b) => a - b),
      inserted, pitches: group.expected.map((index) => raw[index].pitch).sort((a, b) => a - b), bar: Math.floor(raw[top].start * bpm / 60 / 4) + 1 });
    inserted = [];
  }
  attacks.sort((a, b) => a.expected - b.expected);
  const timed = attacks.filter((attack) => attack.played !== null);
  const pairs = timed.slice(1).map((attack, index) => [timed[index], attack] as const);
  for (const [a, b] of pairs) {
    const expected = b.expected - a.expected, played = b.played! - a.played!;
    b.ratio = expected > 0.07 && played > 0.07 ? played / expected : null;
  }
  const names = namingKey(key), issues: [number, string][] = [], crossings: number[] = [], others: number[] = [];
  for (const [index, [a, b]] of pairs.entries()) {
    const window = pairs.slice(Math.max(0, index - LOCAL), index + LOCAL + 1).map((pair) => pair[1].ratio).filter((ratio): ratio is number => Boolean(ratio));
    const local = window.length ? median(window) : 1;
    const nearby = pairs.slice(Math.max(0, index - 1), index + 2).map((pair) => pair[1].ratio).filter((ratio): ratio is number => Boolean(ratio));
    b.tempo = nearby.length ? roundDecimal(bpm / median(nearby), 1) : null;
    const gap = (b.expected - a.expected) * local, deviation = b.played! - a.played! - gap;
    b.deviation_ms = roundEven(1000 * deviation) || 0;
    if (deviation > Math.max(0.12, 0.35 * gap)) b.flag = "late";
    else if (deviation < -Math.max(0.08, 0.3 * gap)) b.flag = "early";
    (crossing(raw[a.index], raw[b.index]) ? crossings : others).push(deviation);
  }
  for (const attack of attacks) {
    if (!attack.flag || attack.flag === "late" && attack.inserted.length) continue;
    const where = `${pitchName(raw[attack.index].pitch, names)} in bar ${attack.bar}`, size = Math.abs(attack.deviation_ms!);
    issues.push([size / 1000, attack.flag === "late" ? `Pause before ${where}: ${size} ms late` : `Rushed into ${where}: ${size} ms early`]);
  }
  for (const attack of attacks) for (const [weight, text] of describeSlips(attack, names)) issues.push([weight, `${text} in bar ${attack.bar}`]);
  let crossingMs: number | null = null;
  if (crossings.length >= 3 && others.length) {
    crossingMs = roundEven(1000 * (median(crossings) - median(others))) || 0;
    if (crossingMs >= 40) issues.push([5, `Thumb crossings ran ${crossingMs} ms late compared with the other notes`]);
  }
  issues.sort((a, b) => b[0] - a[0]);
  if (timed.length >= 2) timed[0].tempo = timed[1].tempo;
  const ratios = pairs.map((pair) => pair[1].ratio).filter((ratio): ratio is number => Boolean(ratio));
  const timeline = attacks.map((attack) => ({ index: attack.index, bar: attack.bar, deviation_ms: attack.deviation_ms ?? null,
    flag: attack.flag ?? null, velocity: attack.velocity, tempo: attack.tempo ?? null, missed: Boolean(attack.missed.length) }));
  return { timeline, issues: issues.slice(0, 5).map((item) => item[1]), crossing_ms: crossingMs,
    bpm: ratios.length ? roundDecimal(bpm / median(ratios), 1) : null, drift_percent: drillDrift(ratios),
    pauses: attacks.filter((attack) => attack.flag === "late").length };
}

export function drillDrift(ratios: number[]): number | null {
  const valid = ratios.filter(Boolean);
  if (valid.length < 6) return null;
  const third = Math.floor(valid.length / 3);
  return roundDecimal(100 * (median(valid.slice(0, third)) / median(valid.slice(-third)) - 1), 1);
}

function crossing(previous: DrillNote, note: DrillNote): boolean {
  if (!previous.finger || !note.finger || previous.hand !== note.hand) return false;
  const fingers = note.finger - previous.finger, pitches = note.pitch - previous.pitch;
  if (!fingers || !pitches) return false;
  return previous.hand === "right" ? (fingers > 0) !== (pitches > 0) : (fingers > 0) === (pitches > 0);
}

export function namingKey(key: MusicalKey): MusicalKey {
  if (key.mode !== "minor") return key;
  const pitch_classes = [...key.pitch_classes], scale_names = [...key.scale_names];
  for (const step of [5, 6]) {
    pitch_classes.push((key.pitch_classes[step] + 1) % 12);
    const name = key.scale_names[step];
    scale_names.push(name.endsWith("b") ? name.slice(0, -1) : name + "#");
  }
  return { ...key, pitch_classes, scale_names };
}

export function pitchName(pitch: number, key: MusicalKey): string {
  const index = key.pitch_classes.indexOf(pitch % 12);
  if (index >= 0) {
    const name = key.scale_names[index], natural = ["C", "D", "E", "F", "G", "A", "B"].indexOf(name[0]);
    const semitone = [0, 2, 4, 5, 7, 9, 11][natural] + [...name].filter((letter) => letter === "#").length - [...name].filter((letter) => letter === "b").length;
    return name.replaceAll("#", "♯").replaceAll("b", "♭") + (Math.floor((pitch - semitone) / 12) - 1);
  }
  return ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][pitch % 12] + (Math.floor(pitch / 12) - 1);
}

function describeSlips(attack: Attack, key: MusicalKey): [number, string][] {
  const missed = [...attack.missed], played = attack.pitches.filter((pitch) => !missed.includes(pitch));
  const written = attack.pitches.map((pitch) => pitchName(pitch, key)).join(" + "), slips: [number, string][] = [];
  for (const pitches of attack.inserted) {
    const heard = pitches.map((pitch) => pitchName(pitch, key)).join(" + ");
    if (JSON.stringify(pitches) === JSON.stringify(attack.pitches)) slips.push([6, `Played ${written} twice`]);
    else if (pitches.filter((pitch) => attack.pitches.includes(pitch)).length * 2 >= attack.pitches.length && !missed.length) slips.push([10, `Played ${heard} first, then corrected it to ${written}`]);
    else slips.push([8, `Extra ${heard} before ${written}`]);
  }
  for (const pitch of attack.extra) {
    const name = pitchName(pitch, key);
    const replaced = missed.filter((other) => Math.abs(other - pitch) <= 2).sort((a, b) => Math.abs(a - pitch) - Math.abs(b - pitch))[0];
    const neighbour = played.filter((other) => Math.abs(other - pitch) <= 2).sort((a, b) => Math.abs(a - pitch) - Math.abs(b - pitch))[0];
    const octave = attack.pitches.find((other) => pitch !== other && (pitch - other) % 12 === 0);
    if (replaced !== undefined) { missed.splice(missed.indexOf(replaced), 1); slips.push([10, `Played ${name} instead of ${pitchName(replaced, key)}`]); }
    else if (neighbour !== undefined) slips.push([9, `Caught ${name} beside ${pitchName(neighbour, key)}`]);
    else if (octave !== undefined) slips.push([4, `Heard an extra ${name}, an octave from ${pitchName(octave, key)}; possibly an overtone`]);
    else slips.push([8, `Extra ${name}`]);
  }
  if (missed.length) slips.push([10, `Missed ${missed.sort((a, b) => a - b).map((pitch) => pitchName(pitch, key)).join(" + ")}`]);
  return slips;
}
