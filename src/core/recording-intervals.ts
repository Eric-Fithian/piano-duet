export type RecordingInterval = [number, number];

export function decodeRecordingIntervals(score: Float32Array, skip: Float32Array, frames: number,
  tracks: number, starts: number[]): RecordingInterval[][] {
  if (!Number.isInteger(frames) || frames < 2 || !Number.isInteger(tracks) || tracks < 1
      || score.length !== frames * frames * tracks || skip.length !== (frames - 1) * tracks
      || starts.length !== tracks || starts.some((value) => !Number.isInteger(value) || value < 0 || value >= frames)) {
    throw new Error("Invalid recording interval scores");
  }
  const values = new Float32Array(frames * tracks);
  const choices = new Int32Array((frames - 1) * tracks);
  const best = new Float32Array(tracks);
  const selected = new Int32Array(tracks);
  for (let track = 0; track < tracks; track++) {
    const diagonal = score[((frames - 1) * frames + frames - 1) * tracks + track];
    if (!Number.isFinite(diagonal)) throw new Error("Non-finite recording interval score");
    values[(frames - 1) * tracks + track] = Math.max(0, diagonal);
  }
  for (let begin = frames - 2; begin >= 0; begin--) {
    for (let track = 0; track < tracks; track++) {
      const value = Math.fround(values[(begin + 1) * tracks + track] + skip[begin * tracks + track]);
      if (!Number.isFinite(value)) throw new Error("Non-finite recording interval score");
      best[track] = value;
      selected[track] = -1;
    }
    for (let end = begin + 1; end < frames; end++) {
      const row = (end * frames + begin) * tracks, next = end * tracks;
      for (let track = 0; track < tracks; track++) {
        const value = Math.fround(values[next + track] + score[row + track]);
        if (!Number.isFinite(value)) throw new Error("Non-finite recording interval score");
        if (value > best[track]) { best[track] = value; selected[track] = end; }
      }
    }
    for (let track = 0; track < tracks; track++) {
      const diagonal = score[(begin * frames + begin) * tracks + track];
      if (!Number.isFinite(diagonal)) throw new Error("Non-finite recording interval score");
      const total = Math.fround(best[track] + Math.max(0, diagonal));
      if (!Number.isFinite(total)) throw new Error("Non-finite recording interval score");
      values[begin * tracks + track] = total;
      choices[begin * tracks + track] = selected[track];
    }
  }
  return starts.map((start, track) => {
    const intervals: RecordingInterval[] = [];
    let position = start;
    while (position < frames - 1) {
      if (score[(position * frames + position) * tracks + track] > 0) intervals.push([position, position]);
      const next = choices[position * tracks + track];
      if (next < 0) position++;
      else { intervals.push([position, next]); position = next; }
    }
    if (score[((frames - 1) * frames + frames - 1) * tracks + track] > 0) intervals.push([frames - 1, frames - 1]);
    return intervals;
  });
}
