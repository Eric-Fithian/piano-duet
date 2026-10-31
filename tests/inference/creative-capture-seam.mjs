export function installDeterministicCapture() {
  const BrowserAudioWorkletNode = window.AudioWorkletNode;
  const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
  if (!onmessage?.set) throw new Error("The capture message port cannot be controlled by the test");
  window.AudioWorkletNode = class extends BrowserAudioWorkletNode {
    constructor(context, name, ...options) {
      super(context, name, ...options);
      if (name !== "piano-capture") return;
      const port = this.port, test = window.__duetTest;
      let receiver;
      Object.defineProperty(port, "onmessage", { configurable: true, get: () => receiver, set: (callback) => {
        receiver = callback;
        onmessage.set.call(port, callback ? (event) => { if (!test.injecting) callback.call(port, event); } : null);
      } });
      test.inject = async (audio) => {
        if (!receiver || context.state !== "running") throw new Error("The capture seam is not ready");
        const start = context.currentTime + 0.5;
        test.injecting = true;
        for (let offset = 0; offset < audio.length; offset += 1024) {
          receiver.call(port, { data: { samples: audio.slice(offset, offset + 1024), capturedAt: start + offset / context.sampleRate } });
          await Promise.resolve();
        }
        test.injecting = false;
      };
    }
  };
}
