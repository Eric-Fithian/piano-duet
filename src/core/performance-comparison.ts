import { mean, median, roundEven } from "./numeric.ts";

export type PerformanceNote = { pitch: number; start: number };
type Group = { start: number; pitches: Map<number, number>; indices: number[] };
type Move = "pair" | "missing" | "extra";
type Cell = { cost: number; matched: number };

function groups(notes: PerformanceNote[]): Group[] {
  const result: Group[] = [];
  const ordered = notes.map((note, index) => ({ note, index })).sort((a, b) => a.note.start - b.note.start || a.note.pitch - b.note.pitch);
  for (const { note, index } of ordered) {
    let group = result.at(-1);
    if (!group || note.start > group.start + 0.07) {
      group = { start: note.start, pitches: new Map(), indices: [] };
      result.push(group);
    }
    group.pitches.set(note.pitch, (group.pitches.get(note.pitch) ?? 0) + 1);
    group.indices.push(index);
  }
  return result;
}

function shared(a: Group, b: Group): number {
  return [...a.pitches].reduce((total, [pitch, count]) => total + Math.min(count, b.pitches.get(pitch) ?? 0), 0);
}

export function comparePerformance(target: PerformanceNote[], attempt: PerformanceNote[]) {
  if (!target.length || !attempt.length) throw new Error("Scoring requires a target and a recognized attempt");
  const expected = groups(target), played = groups(attempt);
  const n = expected.length, m = played.length, width = Math.max(32, Math.abs(n - m) + 4);
  let previous = new Map<number, Cell>([[0, { cost: 0, matched: 0 }]]);
  const trace = new Map<string, Move>();
  const key = (i: number, j: number) => `${i},${j}`;
  for (let j = 1; j <= Math.min(m, width); j++) {
    previous.set(j, { cost: previous.get(j - 1)!.cost + played[j - 1].indices.length, matched: 0 });
    trace.set(key(0, j), "extra");
  }
  const absent = { cost: Infinity, matched: 0 };
  for (let i = 1; i <= n; i++) {
    const current = new Map<number, Cell>();
    const a = expected[i - 1];
    for (let j = Math.max(0, i - width); j <= Math.min(m, i + width); j++) {
      const above = previous.get(j) ?? absent;
      const options: { cell: Cell; move: Move }[] = [{ cell: { cost: above.cost + a.indices.length, matched: above.matched }, move: "missing" }];
      if (j) {
        const b = played[j - 1], overlap = shared(a, b), diagonal = previous.get(j - 1) ?? absent, left = current.get(j - 1) ?? absent;
        options.unshift({ cell: { cost: diagonal.cost + Math.max(a.indices.length, b.indices.length) - overlap, matched: diagonal.matched - overlap }, move: "pair" });
        options.push({ cell: { cost: left.cost + b.indices.length, matched: left.matched }, move: "extra" });
      }
      const best = options.reduce((a, b) => b.cell.cost < a.cell.cost || b.cell.cost === a.cell.cost && b.cell.matched < a.cell.matched ? b : a);
      current.set(j, best.cell);
      trace.set(key(i, j), best.move);
    }
    previous = current;
  }
  let matches = 0, wrong = 0, missing = 0, extra = 0, i = n, j = m;
  const alignment: { expected: number[]; played: number[] }[] = [], pairs: [number, number][] = [];
  while (i || j) {
    const move = trace.get(key(i, j));
    if (move === "pair") {
      const a = expected[i - 1], b = played[j - 1], overlap = shared(a, b);
      const misses = a.indices.length - overlap, additions = b.indices.length - overlap;
      alignment.push({ expected: a.indices, played: b.indices });
      matches += overlap; wrong += Math.min(misses, additions); missing += Math.max(0, misses - additions); extra += Math.max(0, additions - misses);
      if (overlap) pairs.push([a.start, b.start]);
      i--; j--;
    } else if (move === "missing") {
      alignment.push({ expected: expected[i - 1].indices, played: [] });
      missing += expected[i - 1].indices.length;
      i--;
    } else if (move === "extra") {
      alignment.push({ expected: [], played: played[j - 1].indices });
      extra += played[j - 1].indices.length;
      j--;
    } else throw new Error(`Missing alignment at ${i}, ${j}`);
  }
  pairs.reverse(); alignment.reverse();
  const intervals = pairs.slice(1).map((pair, index) => [pair[0] - pairs[index][0], pair[1] - pairs[index][1]]);
  const ratios = intervals.filter(([a, b]) => a > 0.07 && b > 0.07).map(([a, b]) => b / a);
  const scale = intervals.length ? median(ratios) : 1;
  const errors = intervals.map(([a, b]) => Math.abs(b / scale - a));
  const rhythm = errors.length ? mean(errors.map((error) => Math.exp(-Math.max(0, error - 0.06) / 0.18))) : null;
  const pitch = 2 * matches / (target.length + attempt.length);
  return { score: roundEven(100 * pitch * (rhythm === null ? 1 : 0.8 + 0.2 * rhythm)), pitch_accuracy: roundEven(100 * pitch),
    rhythm_accuracy: rhythm === null ? null : roundEven(100 * rhythm), matched: matches, wrong, missing, extra,
    target_notes: target.length, played_notes: attempt.length, tempo_percent: roundEven(100 / scale),
    timing_error_ms: errors.length ? roundEven(1000 * mean(errors)) : null, alignment };
}
