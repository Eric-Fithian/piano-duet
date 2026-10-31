import { createServer, request as httpRequest } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const recordingDirectory = process.env.PIANO_RECORDING_MODEL_DIR ?? ".cache/models/recording-transcription/onnx-fp32";
const paths = {
  "/runner.mjs": "tests/inference/browser-runner.mjs",
  "/worker.mjs": "tests/inference/browser-worker.mjs",
  "/models/transcription.onnx": ".cache/browser-inference/transcription.onnx",
  "/models/transcription-convolution-fp32.onnx": ".cache/browser-inference/transcription-convolution-fp32.onnx",
  "/models/transcription-recurrent.onnx": ".cache/browser-inference/transcription-recurrent.onnx",
  "/fixtures/transcription.json": ".cache/browser-inference/transcription.json",
  "/models/aria/model.onnx": ".cache/models/aria/onnx-int4-block64/model.onnx",
  "/models/aria/model.onnx.data": ".cache/models/aria/onnx-int4-block64/model.onnx.data",
  "/models/local-fixture/model.onnx": ".cache/models/aria/onnx-int4-block64/model.onnx",
  "/models/local-fixture/model.onnx.data": ".cache/models/aria/onnx-int4-block64/model.onnx.data",
  "/models/local-fixture/convolution.onnx": ".cache/browser-inference/transcription-convolution-fp32.onnx",
  "/models/local-fixture/recurrent.onnx": ".cache/browser-inference/transcription-recurrent.onnx",
  "/models/local-fixture/graph.onnx": ".cache/browser-inference/transcription.onnx",
  "/models/local-fixture/recording-features.onnx": `${recordingDirectory}/features.onnx`,
  "/models/local-fixture/recording-attributes.onnx": `${recordingDirectory}/attributes.onnx`,
  "/fixtures/recording.pcm": ".cache/browser-inference/recording.pcm",
  "/models/score/encoder.onnx": ".cache/m2st/onnx-public/encoder.onnx",
  "/models/score/decoder-first.onnx": ".cache/m2st/onnx-public/decoder-first.onnx",
  "/models/score/decoder-context.onnx": ".cache/m2st/onnx-public/decoder-context.onnx",
  "/models/score/decoder-step.onnx": ".cache/m2st/onnx-public/decoder-step.onnx",
  "/fixtures/score-fixture.json": ".cache/m2st/score-fixture.json",
  "/fixtures/aria.json": ".cache/models/aria/onnx-int4-block64/parity.json",
};

export async function startServer({ referencePort } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url === "/" && !referencePort) {
      response.setHeader("Content-Type", "text/html");
      response.end('<script type="module" src="/runner.mjs"></script>');
      return;
    }
    const runtime = request.url.startsWith("/runtime/") ? request.url.slice("/runtime/".length) : null;
    if (runtime && (runtime.includes("/") || runtime.includes(".."))) throw new Error("Invalid runtime path");
    const path = runtime ? `node_modules/onnxruntime-web/dist/${runtime}` : paths[request.url];
    if (!path) {
      if (referencePort) {
        const headers = { ...request.headers, host: `127.0.0.1:${referencePort}` };
        if (headers.origin) headers.origin = `http://127.0.0.1:${referencePort}`;
        const upstream = httpRequest({ host: "127.0.0.1", port: referencePort, path: request.url,
          method: request.method, headers }, (upstreamResponse) => {
          const forwarded = { ...upstreamResponse.headers,
            "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
          if (forwarded["content-security-policy"]) {
            forwarded["content-security-policy"] = forwarded["content-security-policy"]
              .replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") + "; worker-src 'self'";
          }
          response.writeHead(upstreamResponse.statusCode, forwarded);
          upstreamResponse.pipe(response);
        });
        upstream.on("error", (error) => { throw error; });
        request.pipe(upstream);
        return;
      }
      response.writeHead(404).end();
      return;
    }
    const details = await stat(path);
    response.setHeader("Content-Length", details.size);
    response.setHeader("Content-Type", path.endsWith(".mjs") ? "text/javascript" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    createReadStream(path).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
