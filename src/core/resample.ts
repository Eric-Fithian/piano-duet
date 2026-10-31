const kernels = new Map<number, { up: number; down: number; preRemove: number; coefficients: Float32Array }>();

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

function filter(up: number, down: number): { up: number; down: number; preRemove: number; coefficients: Float32Array } {
  const maximum = Math.max(up, down), half = 10 * maximum, prePad = down - half % down;
  const unscaled = new Float64Array(2 * half + 1), denominator = besselI0(5);
  let sum = 0;
  for (let index = 0; index < unscaled.length; index++) {
    const offset = index - half, ratio = offset / half;
    const sinc = offset === 0 ? 1 / maximum : Math.sin(Math.PI * offset / maximum) / (Math.PI * offset);
    const value = sinc * besselI0(5 * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / denominator;
    unscaled[index] = value; sum += value;
  }
  const coefficients = new Float32Array(prePad + unscaled.length);
  for (let index = 0; index < unscaled.length; index++) coefficients[prePad + index] = Math.fround(Math.fround(unscaled[index] / sum) * up);
  return { up, down, preRemove: (half + prePad) / down, coefficients };
}

export function resample16To441(audio: Float32Array): Float32Array {
  return resampleTo441(audio, 16000);
}

export function resampleTo441(audio: Float32Array, rate: number): Float32Array {
  if (!audio.length || audio.some((sample) => !Number.isFinite(sample))) throw new Error("Resampling requires finite audio samples");
  if (!Number.isSafeInteger(rate) || rate < 8000 || rate > 192000) throw new Error("Unsupported audio sample rate");
  if (rate === 44100) return audio;
  let kernel = kernels.get(rate);
  if (!kernel) {
    let a = 44100, b = rate;
    while (b) [a, b] = [b, a % b];
    kernel = filter(44100 / a, rate / a);
    kernels.set(rate, kernel);
  }
  const { up, down, preRemove, coefficients } = kernel;
  const result = new Float32Array(Math.ceil(audio.length * up / down));
  for (let output = 0; output < result.length; output++) {
    const position = (output + preRemove) * down;
    const first = Math.max(0, Math.ceil((position - coefficients.length + 1) / up));
    const last = Math.min(audio.length - 1, Math.floor(position / up));
    let value = 0;
    for (let input = first; input <= last; input++) value = Math.fround(value + Math.fround(audio[input] * coefficients[position - input * up]));
    result[output] = value;
  }
  return result;
}
