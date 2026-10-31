const MAX_SECONDS = 15 * 60;

export type TabCapture = { stop(): Promise<ArrayBuffer>; cancel(): Promise<void> };

export async function captureTabAudio(stream: MediaStream, signal: AbortSignal, onLimit: () => void, onFailure: (error: Error) => void): Promise<TabCapture> {
  const context = new AudioContext({ sampleRate: 16000 });
  let node: AudioWorkletNode | undefined;
  const chunks: Float32Array[] = [];
  let samples = 0, resolveFlush: (() => void) | undefined, rejectFlush: ((error: Error) => void) | undefined, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stream.getTracks().forEach((track) => track.stop());
    node?.disconnect();
    await context.close();
  };
  try {
    signal.throwIfAborted();
    await context.audioWorklet.addModule(new URL("../../../src/piano_duet/static/capture.js", import.meta.url).href);
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, "piano-capture", { channelCount: 1, channelCountMode: "explicit" });
    const active = node, silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(stream).connect(active).connect(silent).connect(context.destination);
    active.port.onmessage = ({ data }: MessageEvent<{ samples?: Float32Array; flushed?: boolean }>) => {
      if (data.flushed) { resolveFlush?.(); return; }
      if (!data.samples) throw new Error("The capture worklet returned no audio samples");
      const available = Math.max(0, MAX_SECONDS * context.sampleRate - samples);
      const part = data.samples.subarray(0, available);
      if (part.length) { chunks.push(part); samples += part.length; }
      if (samples >= MAX_SECONDS * context.sampleRate) onLimit();
    };
    active.onprocessorerror = () => {
      const error = new Error("Tab audio capture failed");
      if (rejectFlush) rejectFlush(error); else onFailure(error);
    };
    await context.resume();
    signal.throwIfAborted();
    return {
      async stop() {
        signal.throwIfAborted();
        let abort: (() => void) | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            resolveFlush = resolve; rejectFlush = reject;
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            active.port.postMessage("flush");
          });
        } finally {
          if (abort) signal.removeEventListener("abort", abort);
          await close();
        }
        signal.throwIfAborted();
        if (!samples) throw new Error("No audio was captured. Play the video while sharing its tab.");
        return waveAudio(chunks, samples, context.sampleRate);
      },
      cancel: close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function waveAudio(chunks: Float32Array[], length: number, rate: number): ArrayBuffer {
  const data = new ArrayBuffer(44 + length * 4), view = new DataView(data);
  const write = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, data.byteLength - 8, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  write(36, "data"); view.setUint32(40, length * 4, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) { view.setFloat32(offset, sample, true); offset += 4; }
  if (offset !== data.byteLength) throw new Error("Captured audio length does not match its WAV header");
  return data;
}
