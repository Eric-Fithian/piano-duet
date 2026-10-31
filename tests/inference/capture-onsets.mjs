export function hasSpacedOnsets(onsets, count, spacing, tolerance) {
  if (!Array.isArray(onsets) || onsets.some((time, index) => !Number.isFinite(time) || time < 0 || (index && time < onsets[index - 1]))
      || !Number.isInteger(count) || count < 1 || !Number.isFinite(spacing) || spacing <= 0
      || !Number.isFinite(tolerance) || tolerance < 0 || tolerance >= spacing / 2) throw new Error("Invalid captured-onset comparison");
  for (let first = 0; first < onsets.length; first++) {
    let matched = 1;
    for (let index = first + 1; index < onsets.length && matched < count; index++) {
      if (Math.abs(onsets[index] - (onsets[first] + matched * spacing)) <= tolerance) matched++;
    }
    if (matched === count) return true;
  }
  return false;
}
