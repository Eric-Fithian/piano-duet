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

export class PianoSound {
  constructor(context) {
    this.context = context;
    this.samples = [];
    this.sources = new Set();
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
      this.sources.add(source);
      source.onended = () => { this.sources.delete(source); source.disconnect(); envelope.disconnect(); };
    }
  }
  stop() {
    for (const source of this.sources) source.stop();
    this.sources.clear();
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
