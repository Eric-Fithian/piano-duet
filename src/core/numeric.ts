// Python's round uses ties-to-even, including for values ending in .5.
export function roundEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

export function roundDecimal(value: number, digits: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0 || digits > 12) throw new Error("Invalid decimal rounding input");
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  const scale = 10n ** BigInt(digits);
  const numerator = mantissa * scale * (exponent > 0 ? 1n << BigInt(exponent) : 1n);
  const denominator = exponent < 0 ? 1n << BigInt(-exponent) : 1n;
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || remainder * 2n === denominator && rounded % 2n === 1n) rounded++;
  const result = Number(rounded) / Number(scale);
  return value < 0 || Object.is(value, -0) ? -result : result;
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
