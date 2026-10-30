const EPSILON = 1e-9;
const GROUP_FILLINGS: Record<number, number[][]> = { 1: [[1], [0.5, 0.5]], 1.5: [[1.5], [0.5, 0.5, 0.5], [1, 0.5]] };
const FIGURES: Record<string, number[]> = {
  eighths: [0.5, 0.5], dotted: [1.5, 0.5], syncopation: [0.5, 1, 0.5],
  sixteenths: [0.25, 0.25, 0.25, 0.25], triplets: [1 / 3, 1 / 3, 1 / 3],
};

export function beatGroups(meter: string): number[] {
  const [numerator, denominator] = meter.split("/").map(Number);
  if (denominator === 4) return Array(numerator).fill(1);
  if (numerator % 3 === 0) return Array(numerator / 3).fill(1.5);
  if (meter === "7/8") return [1, 1, 1.5];
  throw new Error(`Reading scores have no beat grouping for ${meter}`);
}

export function figures(style: string, meter: string): number[][] {
  if (beatGroups(meter).some((group) => group !== 1)) return [[]];
  if (style === "mixed") return Object.values(FIGURES);
  return FIGURES[style] ? [FIGURES[style]] : [[]];
}

function product(items: number[][][]): number[][] {
  return items.reduce<number[][]>((all, options) => all.flatMap((head) => options.map((tail) => [...head, ...tail])), [[]]);
}

function longRhythms(beats: number): number[][] {
  if (beats === 0) return [[]];
  return [1, 2, 4].filter((duration) => duration <= beats)
    .flatMap((duration) => longRhythms(beats - duration).map((tail) => [duration, ...tail]));
}

export function beatStarts(groups: number[]): number[] {
  return groups.reduce<number[]>((starts, group) => [...starts, starts[starts.length - 1] + group], [0]);
}

function compareRhythm(a: number[], b: number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function barRhythms(style: string, meter: string, restAt: number | null = null, ending = 0, figure = false): number[][] {
  const groups = beatGroups(meter);
  const beats = groups.reduce((total, group) => total + group, 0);
  if (style === "held") return [[beats]];
  if (style === "long") {
    if (restAt !== null || ending) throw new Error("Long-note bars have neither rests nor fixed endings");
    return longRhythms(beats);
  }
  const starts = beatStarts(groups);
  const slot = (index: number): number[][] => {
    if (index >= groups.length - ending) return [[groups[index]]];
    if (restAt !== null && Math.abs(starts[index] - restAt) < EPSILON) return [[-groups[index]]];
    return style === "quarters" ? [[groups[index]]] : GROUP_FILLINGS[groups[index]];
  };
  const shapes = figure ? figures(style, meter).filter((shape) => shape.length) : [];
  if (!shapes.length) return product(groups.map((_, index) => slot(index)));
  const rhythms = new Map<string, number[]>();
  for (const shape of shapes) {
    for (let first = 0; first < groups.length; first++) {
      const end = starts[first] + shape.reduce((total, value) => total + value, 0);
      const last = starts.findIndex((start) => Math.abs(start - end) < EPSILON);
      if (last < 0 || last > groups.length - ending) continue;
      if (restAt !== null && starts[first] - EPSILON < restAt && restAt < end - EPSILON) continue;
      for (const head of product(groups.slice(0, first).map((_, index) => slot(index)))) {
        for (const tail of product(groups.slice(last).map((_, index) => slot(last + index)))) {
          const rhythm = [...head, ...shape, ...tail];
          rhythms.set(JSON.stringify(rhythm), rhythm);
        }
      }
    }
  }
  return [...rhythms.values()].sort(compareRhythm);
}

export function restPositions(style: string, meter: string, ending: number): number[] {
  if (style === "held" || style === "long") return [];
  const groups = beatGroups(meter);
  return beatStarts(groups).slice(0, -1).filter((_, index) => index > 0 && index < groups.length - 1 - ending);
}

export function nextValues(rhythms: number[][], prefix: number[]): number[] {
  return [...new Set(rhythms.filter((rhythm) => rhythm.length > prefix.length
    && prefix.every((value, index) => rhythm[index] === value)).map((rhythm) => rhythm[prefix.length]))].sort((a, b) => a - b);
}
