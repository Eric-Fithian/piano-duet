export async function decodeAudioFile(data: ArrayBuffer): Promise<{ audio: Float32Array; backend: string; nativeRate?: number }> {
  const worker = new Worker(new URL("./audio-decoder-worker.ts", import.meta.url), { type: "module" });
  let fallbackReason = "WebCodecs is unavailable or does not preserve the recording's padding";
  return new Promise((resolve, reject) => {
    worker.onmessage = async ({ data: result }: MessageEvent<{ audio?: ArrayBuffer; error?: string; fallback?: ArrayBuffer;
      rate?: number; backend?: string; nativeRate?: number; reason?: string }>) => {
      if (result.fallback) {
        if (result.reason) fallbackReason = result.reason;
        if (!result.rate) { worker.terminate(); reject(new Error("The audio file has no sample rate")); return; }
        try {
          const context = new OfflineAudioContext(1, 1, result.rate);
          const decoded = await context.decodeAudioData(result.fallback);
          if (decoded.sampleRate !== result.rate || !decoded.numberOfChannels || decoded.numberOfChannels > 2) throw new Error("The browser changed the sample rate or the recording has more than two channels");
          const mono = new Float32Array(decoded.length);
          for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
            const plane = decoded.getChannelData(channel);
            for (let index = 0; index < mono.length; index++) mono[index] = Math.fround(mono[index] + plane[index]);
          }
          if (decoded.numberOfChannels === 2) for (let index = 0; index < mono.length; index++) mono[index] = Math.fround(mono[index] * Math.SQRT1_2);
          worker.postMessage({ action: "resample", audio: mono.buffer, rate: result.rate }, [mono.buffer]);
        } catch (error) {
          worker.terminate();
          reject(new Error(`WebCodecs could not decode the file (${fallbackReason}); Web Audio also failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        return;
      }
      worker.terminate();
      if (result.error) reject(new Error(result.error));
      else if (result.audio && result.backend) resolve({ audio: new Float32Array(result.audio), backend: result.backend, nativeRate: result.nativeRate });
      else reject(new Error("The audio worker returned no samples"));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(`The audio worker failed: ${event.message}`)); };
    worker.postMessage({ action: "decode", data }, [data]);
  });
}
