import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startTestServer } from "../web/server.mjs";

const site = await startTestServer();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${site.port}/test/audio-decoder.html`);
  await page.waitForFunction(() => typeof window.verifyAudioDecoder === "function");
  const result = await page.evaluate(async () => {
    const audio = new AudioContext(), source = audio.createOscillator(), destination = audio.createMediaStreamDestination();
    source.frequency.value = 261.63;
    source.connect(destination);
    await audio.resume();
    if (audio.state !== "running") throw new Error("The recording audio context did not start");
    const recorder = new MediaRecorder(destination.stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(); source.start();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    recorder.stop(); source.stop();
    await stopped;
    await audio.close();
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const url = URL.createObjectURL(blob);
    const decoded = await window.verifyAudioDecoder(url);
    URL.revokeObjectURL(url);
    return { encoded: Array.from(new Uint8Array(await blob.arrayBuffer())), ...decoded };
  });
  await writeFile(".cache/audio-formats/media-recorder.webm", Uint8Array.from(result.encoded));
  const reference = spawnSync("uv", ["run", "--frozen", "python", "-c", `
import subprocess
import imageio_ffmpeg
import numpy as np
from scipy.signal import resample_poly
audio = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', '.cache/audio-formats/media-recorder.webm', '-ac', '1', '-f', 'f32le', 'pipe:1'], check=True, capture_output=True).stdout
resampled = resample_poly(np.frombuffer(audio, dtype='<f4'), 147, 160).astype('<f4')
print(resampled.tobytes().hex())
`], { encoding: "utf8", maxBuffer: 10_000_000 });
  assert.equal(reference.status, 0, reference.stderr);
  const bytes = Buffer.from(reference.stdout.trim(), "hex");
  const expected = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(result.audio.length, expected.length);
  let error = 0;
  for (let index = 0; index < expected.length; index++) error += (result.audio[index] - expected[index]) ** 2;
  const rms = Math.sqrt(error / expected.length);
  assert.ok(rms < 0.005, `MediaRecorder RMS error ${rms}`);
  console.log(JSON.stringify({ backend: result.backend, samples: expected.length, rmsError: rms }));
} finally {
  await browser.close();
  site.server.kill("SIGTERM");
}
