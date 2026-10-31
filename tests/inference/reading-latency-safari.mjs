import { Builder, By } from "selenium-webdriver";
import { startServer } from "./server.mjs";
import { installReadingProbe } from "./reading-latency-preload.mjs";

const selected = process.argv[2];
if (selected && !["python", "split-fp32"].includes(selected)) throw new Error("Expected python or split-fp32");
const wasmThreads = Number(process.env.PIANO_SAFARI_WASM_THREADS ?? 2);
if (!Number.isInteger(wasmThreads) || wasmThreads < 1) throw new Error("The Safari WASM thread limit must be positive");
let driver, targetTask, backendForPage;
const server = await startServer({ referencePort: 8879, preloadScript: () =>
  `(${installReadingProbe.toString()})(${JSON.stringify(backendForPage)},${JSON.stringify(targetTask ?? null)},${wasmThreads});` });
const results = [];
try {
  driver = await new Builder().forBrowser("safari").build();
  await driver.manage().setTimeouts({ script: 60000 });
  for (const backend of selected ? [selected] : ["python", "split-fp32"]) {
    for (let trial = 0; trial < (selected ? 1 : 3); trial++) {
      backendForPage = backend;
      await driver.get(`http://127.0.0.1:${server.address().port}/`);
      const fakeInstalled = await driver.executeScript('return window.__latency?.fakeInstalled === true && Object.getPrototypeOf(navigator.mediaDevices).getUserMedia === window.__latency.fakeMicrophone');
      if (!fakeInstalled) throw new Error("Safari did not install the fake microphone before the app started");
      await driver.wait(() => driver.executeScript('return !!document.querySelector("#start") && !document.querySelector("#start").disabled'), 60000);
      if (await driver.executeScript('return document.querySelector("#readingMode").getAttribute("aria-pressed") === "true"')) {
        await driver.findElement(By.css("#modeMenuButton")).click();
      await driver.findElement(By.css("#practiceMode")).click();
        await driver.wait(() => driver.executeScript('return document.querySelector("#practiceMode").getAttribute("aria-pressed") === "true" && !document.querySelector("#start").disabled'), 60000);
      }
      await driver.executeScript("window.__latency.tasks = []");
      await driver.findElement(By.css("#modeMenuButton")).click();
      await driver.findElement(By.css("#readingMode")).click();
      await driver.wait(() => driver.executeScript('return document.querySelector("#readingMode").getAttribute("aria-pressed") === "true" && !document.querySelector("#start").disabled && window.__latency.tasks.length > 0 && !!document.querySelector("#sheetMusic svg")'), 60000);
      targetTask ??= await driver.executeScript("return window.__latency.tasks[0]");
      if (backend === "split-fp32") {
        const prepared = await driver.executeAsyncScript(function (done) {
          window.__prepareLive().then((value) => done({ value }), (error) => done({ error: String(error) }));
        });
        if (prepared.error) throw new Error(prepared.error);
        process.stderr.write(`Safari live worker: ${JSON.stringify(prepared.value)}\n`);
      }
      await driver.findElement(By.css("#start")).click();
      await driver.wait(() => driver.executeScript('return window.__latency.fakeCalls === 1 && window.__latency.streamLabel === "Piano Duet synthetic microphone" && !document.querySelector("#start").disabled'), 30000);
      const played = await driver.executeAsyncScript(function (done) {
        fetch("/fixtures/transcription.json").then((response) => response.json()).then((fixture) => {
          const { audio, destination, tasks } = window.__latency, source = audio.createBufferSource();
          const buffer = audio.createBuffer(1, fixture.audio.length, 16000);
          buffer.copyToChannel(Float32Array.from(fixture.audio), 0);
          source.buffer = buffer;
          source.playbackRate.value = 2 ** ((tasks[0].target[0].pitch - fixture.notes[0].pitch) / 12);
          source.connect(destination);
          window.__latency.active = true;
          source.start(audio.currentTime + 4);
          done({ ok: true });
        }).catch((error) => done({ error: String(error) }));
      });
      if (played.error) throw new Error(played.error);
      try {
        await driver.wait(() => driver.executeScript('return window.__latency.greens.length > 0 || !document.querySelector("#error").hidden'), 30000);
      } catch (error) {
        const state = await driver.executeScript('return { onsets: window.__latency.onsets, heard: window.__latency.heard, windows: window.__latency.windows, contexts: window.__latency.contexts, fakeCalls: window.__latency.fakeCalls, status: document.querySelector("#status")?.textContent, error: document.querySelector("#error")?.textContent }');
        throw new Error(`${backend} did not reach green: ${JSON.stringify(state)}`, { cause: error });
      }
      const observation = await driver.executeScript(function () {
        const x = window.__latency, error = document.querySelector("#error");
        return { onsets: x.onsets, greens: x.greens, pitch: x.tasks[0].target[0].pitch,
          contexts: x.contexts, fakeCalls: x.fakeCalls, streamLabel: x.streamLabel, error: error.hidden ? null : error.textContent };
      });
      if (observation.error) throw new Error(observation.error);
      if (observation.fakeCalls !== 1 || observation.streamLabel !== "Piano Duet synthetic microphone") throw new Error("The Reading stream was not the synthetic microphone");
      const onset = observation.onsets.filter((time) => time <= observation.greens[0]).at(-1);
      if (onset === undefined) throw new Error(`${backend} produced green feedback without a captured onset`);
      results.push({ backend, trial, pitch: observation.pitch, latency_ms: observation.greens[0] - onset, contexts: observation.contexts });
      process.stderr.write(`${JSON.stringify(results.at(-1))}\n`);
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (driver) await driver.quit();
  await new Promise((resolve) => server.close(resolve));
}
