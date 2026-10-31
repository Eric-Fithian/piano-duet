class PianoCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index++) {
      this.buffer[this.offset++] = channel[index];
      if (this.offset === this.buffer.length) {
        const capturedAt = (currentFrame + index + 1 - this.buffer.length) / sampleRate;
        this.port.postMessage({samples: this.buffer, capturedAt}, [this.buffer.buffer]);
        this.buffer = new Float32Array(1024);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('piano-capture', PianoCapture);
