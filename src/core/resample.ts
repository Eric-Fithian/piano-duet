const UP = 441;
const DOWN = 160;
const HALF = 10 * UP;
const PRE_PAD = DOWN - HALF % DOWN;
const PRE_REMOVE = (HALF + PRE_PAD) / DOWN;

function besselI0(value: number): number {
  let sum = 1, term = 1;
  const square = value * value / 4;
  for (let order = 1; order < 100; order++) {
    term *= square / (order * order);
    sum += term;
    if (term <= sum * Number.EPSILON) return sum;
  }
  throw new Error("The resampling window did not converge");
}

function filter(): Float32Array {
  const unscaled = new Float64Array(2 * HALF + 1), denominator = besselI0(5);
  let sum = 0;
  for (let index = 0; index < unscaled.length; index++) {
    const offset = index - HALF, ratio = offset / HALF;
    const sinc = offset === 0 ? 1 / UP : Math.sin(Math.PI * offset / UP) / (Math.PI * offset);
    const value = sinc * besselI0(5 * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / denominator;
    unscaled[index] = value; sum += value;
  }
  const coefficients = new Float32Array(PRE_PAD + unscaled.length);
  for (let index = 0; index < unscaled.length; index++) coefficients[PRE_PAD + index] = Math.fround(Math.fround(unscaled[index] / sum) * UP);
  return coefficients;
}

const FILTER = filter();

export function resample16To441(audio: Float32Array): Float32Array {
  if (!audio.length || audio.some((sample) => !Number.isFinite(sample))) throw new Error("Resampling requires finite audio samples");
  const result = new Float32Array(Math.ceil(audio.length * UP / DOWN));
  for (let output = 0; output < result.length; output++) {
    const position = (output + PRE_REMOVE) * DOWN;
    const first = Math.max(0, Math.ceil((position - FILTER.length + 1) / UP));
    const last = Math.min(audio.length - 1, Math.floor(position / UP));
    let value = 0;
    for (let input = first; input <= last; input++) value = Math.fround(value + Math.fround(audio[input] * FILTER[position - input * UP]));
    result[output] = value;
  }
  return result;
}
