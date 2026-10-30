export class PhraseDetector {
  constructor({pause = 0.9, gate = -48, noise = 0, autoReply = true} = {}) {
    this.pause = pause;
    this.gate = gate;
    this.noise = noise;
    this.autoReply = autoReply;
    this.reset();
  }
  reset() {
    this.chunks = [];
    this.preroll = [];
    this.samples = 0;
    this.quiet = 0;
    this.peak = 0;
    this.active = false;
  }
  feed(chunk) {
    const rms = Math.sqrt(chunk.reduce((sum, x) => sum + x * x, 0) / chunk.length);
    const threshold = Math.max(10 ** (this.gate / 20), this.noise * 3,
                              this.active ? this.peak * 0.065 : 0);
    const sounding = rms > threshold;
    if (!this.active) {
      this.preroll.push(chunk);
      if (this.preroll.length > 4) this.preroll.shift();
      if (!sounding) return {rms};
      this.active = true;
      this.chunks = this.preroll.slice(0, -1);
      this.samples = this.chunks.reduce((sum, part) => sum + part.length, 0);
    }
    this.peak = Math.max(this.peak * 0.999, rms);
    this.chunks.push(chunk);
    this.samples += chunk.length;
    this.quiet = sounding ? 0 : this.quiet + chunk.length / 16000;
    if (this.autoReply && this.quiet >= this.pause && this.samples >= 6400) {
      return {rms, phrase: this.finish()};
    }
    return {rms};
  }
  finish() {
    if (!this.active || this.samples < 1600) return null;
    const audio = new Float32Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) { audio.set(chunk, offset); offset += chunk.length; }
    this.reset();
    return audio;
  }
}

// After the app's own sound ends, the room keeps it audible to the microphone for about this long.
const ECHO = 0.5;
// Seconds a grace note sounds before the note it ornaments, which is about how quickly one is played.
const GRACE_LEAD = 0.06;

export class PianoSound {
  constructor(context) {
    this.context = context;
    this.samples = [];
    this.sources = new Set();
    this.until = -Infinity;
    this.gain = context.createGain();
    this.gain.gain.value = 0.65;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.ratio.value = 5;
    this.gain.connect(compressor).connect(context.destination);
  }
  async load() {
    const response = await fetch('/samples/manifest.json');
    if (!response.ok) throw new Error('Piano samples are missing. Run the setup command again.');
    const manifest = await response.json();
    this.samples = await Promise.all(manifest.map(async entry => {
      const response = await fetch(`/samples/${entry.file}`);
      if (!response.ok) throw new Error(`Could not load piano sample ${entry.file}`);
      return {pitch: entry.pitch, buffer: await this.context.decodeAudioData(await response.arrayBuffer())};
    }));
  }
  play(note, when, context = this.context, destination = this.gain) {
    // A grace note is written on its main note's beat and sounds just before it.
    if (note.grace) {
      when = Math.max(0, when - GRACE_LEAD);
      note = {...note, duration: GRACE_LEAD};
    }
    const sample = this.samples.reduce((best, item) =>
      Math.abs(item.pitch - note.pitch) < Math.abs(best.pitch - note.pitch) ? item : best);
    const source = context.createBufferSource();
    const envelope = context.createGain();
    source.buffer = sample.buffer;
    source.playbackRate.value = 2 ** ((note.pitch - sample.pitch) / 12);
    const volume = Math.max(0.025, (note.velocity / 127) ** 1.5) * 0.65;
    envelope.gain.setValueAtTime(volume, when);
    envelope.gain.setValueAtTime(volume, when + note.duration);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + note.duration + 0.18);
    source.connect(envelope).connect(destination);
    source.start(when);
    source.stop(when + note.duration + 0.2);
    if (context === this.context) {
      this.sound(when + note.duration + 0.2);
      this.sources.add(source);
      source.onended = () => { this.sources.delete(source); source.disconnect(); envelope.disconnect(); };
    }
  }
  stop() {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.until = this.context.currentTime;
  }
  // Note other sounds made through this output, such as metronome clicks.
  sound(until) {
    this.until = Math.max(this.until, until);
  }
  // While the app is making sound, the microphone would hear it as playing; listening waits.
  get audible() {
    return this.context.currentTime < this.until + ECHO;
  }
  async example() {
    const context = new OfflineAudioContext(1, 16000 * 5, 16000);
    const melody = [60, 64, 67, 69, 67, 64, 62, 60];
    const notes = melody.map((pitch, i) => ({pitch, start: 0.2 + i * 0.45, duration: 0.36, velocity: 85}));
    notes.push(...[48, 55, 52].map(pitch => ({pitch, start: 0.2, duration: 1.5, velocity: 70})));
    notes.push(...[43, 50, 53].map(pitch => ({pitch, start: 2, duration: 1.5, velocity: 70})));
    for (const note of notes) this.play(note, note.start, context, context.destination);
    const rendered = await context.startRendering();
    return {audio: rendered.getChannelData(0).slice(), notes};
  }
}

export async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    pending += decoder.decode(value, {stream: true});
    let boundary;
    while ((boundary = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield JSON.parse(pending);
}

// Counts piano attacks live, by log-magnitude spectral flux (Böck & Widmer's SuperFlux, without its
// vibrato filter): every 10 ms, how much energy appeared at frequencies that were quieter just before.
// Each frequency bin is compared only with itself (`spread` 0): with 31 Hz bins, a step between low
// notes (C3 to D3 is 16 Hz) lands in the neighbouring bin, and comparing against neighbours hid most
// legato left-hand attacks. A piano has no vibrato for the neighbour comparison to absorb.
// Loudness alone misses legato attacks, which barely raise the overall level. A frame counts when its
// flux is a local peak that clears the recent average by `delta`, the frame is above the noise
// `floor`, and the last attack is at least `refractory` seconds away, so a rolled chord counts once.
// The spectrum is scaled by how loud the playing has recently been, so soft playing or a quiet
// microphone is judged like loud playing: an unscaled flux shrinks with the input level, and soft
// notes would go uncounted.
// Recognition happens after a take; this lets the score and the rep counter follow the player's tempo.
// The recent playing level the spectrum is scaled to, and how fast that memory fades (half in about 3 s).
const TARGET = 0.2;
const REFERENCE_DECAY = 0.5 ** (1 / 300);
// Playing is never treated as quieter than this many noise floors, so silence is not scaled up into attacks.
const QUIETEST = 2;
// An attack's frame must be this loud relative to the noise floor. Flux, not loudness, finds the attacks, so the
// gate only has to keep pure room sound out; at a full floor, soft notes in a noisy room went uncounted.
const GATE = 0.5;

export class AttackCounter {
  constructor({size = 512, hop = 160, rate = 16000, delta = 0.05, refractory = 0.07, compression = 5, target = TARGET, spread = 0} = {}) {
    this.size = size;
    this.hop = hop;
    this.rate = rate;
    this.delta = delta;
    this.refractory = refractory;
    this.compression = compression;
    this.target = target;
    this.spread = spread;
    this.window = Float32Array.from({length: size}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
    this.reverse = Uint32Array.from({length: size}, (_, i) => {
      let value = 0;
      for (let bit = 1, j = i; bit < size; bit <<= 1, j >>= 1) value = (value << 1) | (j & 1);
      return value;
    });
    this.real = new Float32Array(size);
    this.imaginary = new Float32Array(size);
    this.reset();
  }
  reset() {
    this.count = 0;
    this.times = [];
    // The loudness of each counted attack, so weak ones (room sound, a ringing note) can be told apart later.
    this.strengths = [];
    this.samples = new Float32Array(0);
    this.previous = null;
    this.flux = [];
    this.levels = [];
    this.base = 0;
    this.seconds = 0;
    this.last = -Infinity;
    this.reference = 0;
  }
  spectrum(offset, gain) {
    const {size, real, imaginary} = this;
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const value = this.samples[offset + i];
      energy += value * value;
      real[this.reverse[i]] = value * this.window[i];
      imaginary[this.reverse[i]] = 0;
    }
    for (let length = 2; length <= size; length <<= 1) {
      const angle = -2 * Math.PI / length;
      for (let start = 0; start < size; start += length) {
        for (let k = 0; k < length / 2; k++) {
          const wr = Math.cos(angle * k), wi = Math.sin(angle * k);
          const a = start + k, b = a + length / 2;
          const tr = wr * real[b] - wi * imaginary[b], ti = wr * imaginary[b] + wi * real[b];
          real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
          real[a] += tr; imaginary[a] += ti;
        }
      }
    }
    const magnitude = new Float32Array(size / 2);
    for (let k = 1; k < size / 2; k++) magnitude[k] = Math.log1p(this.compression * gain * Math.hypot(real[k], imaginary[k]));
    return {magnitude, level: Math.sqrt(energy / size)};
  }
  feed(chunk, floor) {
    const joined = new Float32Array(this.samples.length + chunk.length);
    joined.set(this.samples);
    joined.set(chunk, this.samples.length);
    this.samples = joined;
    this.seconds += chunk.length / this.rate;
    let offset = 0;
    for (; offset + this.size <= this.samples.length; offset += this.hop) {
      // The scale comes from before this frame, so an attack is measured against the quieter moment before it.
      const gain = this.target / Math.max(this.reference, QUIETEST * floor);
      const {magnitude, level} = this.spectrum(offset, gain);
      this.reference = Math.max(level, this.reference * REFERENCE_DECAY);
      let flux = 0;
      if (this.previous) {
        for (let k = 1; k < magnitude.length; k++) {
          // Compare against the loudest neighbouring bin before, so a slight pitch wobble is not an attack.
          const before = this.spread ? Math.max(this.previous[k - 1], this.previous[k], this.previous[k + 1] ?? 0) : this.previous[k];
          flux += Math.max(0, magnitude[k] - before);
        }
        flux /= magnitude.length;
      }
      this.previous = magnitude;
      this.flux.push(flux);
      this.levels.push(level);
      this.pick(floor);
    }
    this.samples = this.samples.slice(offset);
    return this.count;
  }
  // Decide the frame three frames back, once its neighbours on both sides are known.
  pick(floor) {
    const centre = this.flux.length - 4;
    if (centre < 1) return;
    const value = this.flux[centre];
    const near = this.flux.slice(Math.max(0, centre - 3), centre + 4);
    const recent = this.flux.slice(Math.max(0, centre - 10), centre + 4);
    const average = recent.reduce((sum, item) => sum + item, 0) / recent.length;
    const time = ((this.base + centre) * this.hop + this.size / 2) / this.rate;
    if (value === Math.max(...near) && value >= average + this.delta && this.levels[centre] > GATE * floor && time - this.last >= this.refractory) {
      this.count++;
      this.times.push(time);
      this.strengths.push(this.levels[centre]);
      this.last = time;
    }
    if (this.flux.length > 64) { this.flux.shift(); this.levels.shift(); this.base++; }
  }
}
