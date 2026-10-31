window.measure = (model, backend, verbose) => new Promise((resolve, reject) => {
  const worker = new Worker("/worker.mjs", { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "ready") return;
    worker.terminate();
    if (data.error) reject(new Error(data.error));
    else resolve(data.value);
  };
  worker.onerror = (error) => {
    worker.terminate();
    reject(new Error(error.message));
  };
  worker.postMessage({ model, backend, verbose });
});
