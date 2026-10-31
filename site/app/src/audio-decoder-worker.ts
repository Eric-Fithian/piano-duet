import { ALL_FORMATS, AudioSampleSink, BufferSource, Input } from "mediabunny";
import { resampleTo441 } from "../../../src/core/resample.ts";
import { decodeWaveAudio } from "../../../src/core/wave-audio.ts";

type Request = { action: "decode"; data: ArrayBuffer } | { action: "resample"; audio: ArrayBuffer; rate: number };

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    if (data.action === "resample") {
      const audio = resampleTo441(new Float32Array(data.audio), data.rate);
      self.postMessage({ audio: audio.buffer, backend: "webaudio" }, { transfer: [audio.buffer] });
      return;
    }
    const bytes = new Uint8Array(data.data, 0, Math.min(12, data.data.byteLength));
    if (bytes.length === 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
        && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE") {
      const audio = decodeWaveAudio(data.data);
      self.postMessage({ audio: audio.buffer, backend: "wav" }, { transfer: [audio.buffer] });
      return;
    }
    const input = new Input({ source: new BufferSource(data.data), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error("The file does not contain an audio track");
      const rate = await track.getSampleRate();
      const codec = await track.getCodec();
      if (codec === "mp3" || codec === "opus" || !await track.canDecode()) {
        self.postMessage({ fallback: data.data, rate }, { transfer: [data.data] });
        return;
      }
      const chunks: Float32Array[] = [];
      let length = 0, decodedRate = 0;
      try {
        for await (const sample of new AudioSampleSink(track).samples()) {
          try {
          if (!decodedRate) decodedRate = sample.sampleRate;
          if (sample.sampleRate !== decodedRate || !sample.numberOfChannels || sample.numberOfChannels > 2) throw new Error("The audio format changes within the recording or has more than two channels");
          const skip = Math.min(sample.numberOfFrames, Math.max(0, Math.round(-sample.timestamp * sample.sampleRate)));
          const mono = new Float32Array(sample.numberOfFrames - skip);
          for (let channel = 0; channel < sample.numberOfChannels; channel++) {
            const plane = new Float32Array(sample.numberOfFrames);
            sample.copyTo(plane, { format: "f32-planar", planeIndex: channel });
            for (let index = 0; index < mono.length; index++) mono[index] = Math.fround(mono[index] + plane[index + skip]);
          }
          if (sample.numberOfChannels === 2) for (let index = 0; index < mono.length; index++) mono[index] = Math.fround(mono[index] * Math.SQRT1_2);
          chunks.push(mono); length += mono.length;
          } finally { sample.close(); }
        }
      } catch (error) {
        self.postMessage({ fallback: data.data, rate, reason: error instanceof Error ? error.message : String(error) }, { transfer: [data.data] });
        return;
      }
      if (!length) throw new Error("The recording has no audio samples");
      const mono = new Float32Array(length);
      let offset = 0;
      for (const chunk of chunks) { mono.set(chunk, offset); offset += chunk.length; }
      const audio = resampleTo441(mono, decodedRate);
      self.postMessage({ audio: audio.buffer, backend: "webcodecs", nativeRate: decodedRate }, { transfer: [audio.buffer] });
    } finally { input.dispose(); }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
