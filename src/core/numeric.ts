// Python's round uses ties-to-even, including for values ending in .5.
export function roundEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

export function mean(values: number[]): number {
  if (!values.length) throw new Error("Mean requires at least one value");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("Median requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
