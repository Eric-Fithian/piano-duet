export function installReadingProbe(chosenBackend, chosenTask, wasmThreads) {
  const observed = { onsets: [], greens: [], tasks: [], contexts: [], heard: [], windows: [], fakeCalls: 0, active: false };
  window.__latency = observed;
  const NativeAudioContext = window.AudioContext;
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) { super(...args); observed.contexts.push({ requested: args[0]?.sampleRate ?? null, actual: this.sampleRate }); }
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    if (chosenBackend === "split-fp32" && typeof input === "string" && input.startsWith("/api/reading/listen?")) {
      const threshold = Number(new URL(input, location.href).searchParams.get("threshold"));
      const audio = new Float32Array(options.body), peak = audio.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
      observed.windows.push({ at: performance.now(), peak });
      const value = await window.__callLive({ action: "listen", audio, threshold });
      if (value.notes.length) observed.heard.push({ at: performance.now(), notes: value.notes });
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (input === "/api/practice/next" && JSON.parse(options.body).focus === "reading") {
      const response = chosenTask && !JSON.parse(options.body).after
        ? new Response(JSON.stringify(chosenTask), { status: 200, headers: { "Content-Type": "application/json" } })
        : await nativeFetch(input, options);
      observed.tasks.push(await response.clone().json());
      return response;
    }
    const response = await nativeFetch(input, options);
    if (typeof input === "string" && input.startsWith("/api/reading/listen?")) {
      const value = await response.clone().json();
      if (value.notes?.length) observed.heard.push({ at: performance.now(), notes: value.notes });
    }
    return response;
  };
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#start") || observed.audio) return;
    const audio = new AudioContext(), destination = audio.createMediaStreamDestination();
    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error("The fake microphone has no audio track");
    const trackId = track.id;
    let trackPrototype = Object.getPrototypeOf(track), label;
    while (trackPrototype && !label) {
      label = Object.getOwnPropertyDescriptor(trackPrototype, "label");
      if (!label) trackPrototype = Object.getPrototypeOf(trackPrototype);
    }
    if (!label?.get) throw new Error("The fake microphone track has no label getter");
    Object.defineProperty(trackPrototype, "label", { configurable: true, get() {
      return this.id === trackId ? "Piano Duet synthetic microphone" : label.get.call(this);
    } });
    const source = audio.createMediaStreamSource(destination.stream), processor = audio.createScriptProcessor(256, 1, 1), silence = audio.createGain();
    silence.gain.value = 0;
    let lastSound = -Infinity;
    processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0), index = samples.findIndex((sample) => Math.abs(sample) > 0.01), now = performance.now();
      if (index >= 0) { if (now - lastSound > 400) observed.onsets.push(now - (samples.length - index) * 1000 / audio.sampleRate); lastSound = now; }
    };
    source.connect(processor).connect(silence).connect(audio.destination);
    Object.assign(observed, { audio, destination, fakeTrackId: trackId });
    void audio.resume();
  }, true);
  const fakeMicrophone = async () => {
    observed.fakeCalls++;
    if (!observed.audio || !observed.destination) throw new Error("The fake microphone was not initialized");
    if (observed.audio.state !== "running") await observed.audio.resume();
    const track = observed.destination.stream.getAudioTracks()[0];
    if (!track || track.id !== observed.fakeTrackId || track.label !== "Piano Duet synthetic microphone") throw new Error("The microphone stream is not synthetic");
    observed.streamLabel = track.label;
    return observed.destination.stream;
  };
  const mediaDevices = Object.getPrototypeOf(navigator.mediaDevices);
  Object.defineProperty(mediaDevices, "getUserMedia", { configurable: true, value: fakeMicrophone });
  Object.defineProperty(mediaDevices, "enumerateDevices", { configurable: true, value: async () => [] });
  if (navigator.mediaDevices.getUserMedia !== fakeMicrophone) throw new Error("Safari did not install the fake microphone");
  Object.assign(observed, { fakeInstalled: true, fakeMicrophone });
  new MutationObserver(() => {
    if (observed.active && document.querySelector(".score-read-done") && !observed.greens.length) observed.greens.push(performance.now());
  }).observe(document, { subtree: true, attributes: true, childList: true });
  if (chosenBackend === "split-fp32") {
    let worker, sequence = 0;
    const pending = new Map();
    window.__callLive = (message) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ ...message, id });
    });
    window.__prepareLive = async () => {
      worker = new Worker("/worker.mjs", { type: "module" });
      await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data.type === "ready") { observed.workerIsolated = data.isolated; resolve(); return; }
          const request = pending.get(data.id);
          if (!request) throw new Error(`Unexpected live worker response ${data.id}`);
          pending.delete(data.id);
          if (data.error) request.reject(new Error(data.error)); else request.resolve(data.value);
        };
        worker.onerror = (event) => reject(new Error(`Worker failed: ${event.message}`));
      });
      return window.__callLive({ action: "prepare", wasmThreads });
    };
  }
}
