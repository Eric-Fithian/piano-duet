import { decodeAudioFile } from "../src/audio-decoder";

Object.assign(window, {
  async verifyAudioDecoder(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load audio fixture: ${response.status}`);
    const { audio, backend, nativeRate } = await decodeAudioFile(await response.arrayBuffer());
    return { audio: Array.from(audio), backend, nativeRate };
  },
});
