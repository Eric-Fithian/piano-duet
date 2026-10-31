import { spawn } from "node:child_process";
import { get } from "node:http";
import { createServer } from "node:net";
import { resolve } from "node:path";

export async function waitForServer(server, port, label, timeoutMs = 120000) {
  let output = "", last = "connection refused";
  const capture = (chunk) => { output = (output + chunk.toString()).slice(-65536); };
  server.stdout.on("data", capture);
  server.stderr.on("data", (chunk) => { capture(chunk); process.stderr.write(chunk); });
  await new Promise((ready, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeListener("error", onError);
      server.removeListener("close", onExit);
      if (error) {
        server.kill("SIGTERM");
        reject(new Error(`${label} on port ${port}: ${error}; last response: ${last}\nServer output:\n${output || "(none)"}`));
      } else ready();
    };
    const onError = (error) => finish(`process error: ${error.message}`);
    const onExit = (code, signal) => finish(`exited before startup: ${code ?? signal}`);
    const timer = setTimeout(() => finish(`did not return HTTP 200 within ${timeoutMs} ms`), timeoutMs);
    server.once("error", onError);
    server.once("close", onExit);
    const poll = () => {
      if (settled) return;
      const request = get(`http://127.0.0.1:${port}/`, (response) => {
        response.resume();
        if (response.statusCode === 200) finish();
        else { last = `HTTP ${response.statusCode}`; setTimeout(poll, 100); }
      });
      request.on("error", (error) => {
        if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code)) {
          last = error.message;
          setTimeout(poll, 100);
        } else finish(`HTTP request failed: ${error.message}`);
      });
      request.setTimeout(1000, () => request.destroy(Object.assign(new Error("readiness request timed out"), {code: "ETIMEDOUT"})));
    };
    poll();
  });
}

export async function startTestServer(preview = false, requestedPort = 0, timeoutMs = 30000) {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("Invalid test server port");
  let port = requestedPort;
  if (!port) {
    const probe = createServer();
    await new Promise((ready) => probe.listen(0, "127.0.0.1", ready));
    port = probe.address().port;
    await new Promise((closed) => probe.close(closed));
  }
  const args = ["node_modules/vite/bin/vite.js", ...(preview ? ["preview"] : []), "--config", "vite.config.ts", "--port", String(port), "--strictPort"];
  const server = spawn(process.execPath, args, { cwd: resolve("site"), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  await waitForServer(server, port, preview ? "Vite preview" : "Vite development server", timeoutMs);
  return { server, port };
}

export async function enableAllModes(context) {
  await context.route('**/enabled_modes.mjs*', route => route.fulfill({contentType: 'text/javascript',
    body: "export const ENABLED_MODES = ['practice', 'reading', 'drills', 'library', 'duet', 'learning'];"}));
}

export async function startReferenceServer(directory) {
  const probe = createServer();
  await new Promise((ready) => probe.listen(0, "127.0.0.1", ready));
  const port = probe.address().port;
  await new Promise((closed) => probe.close(closed));
  const code = "import sys, pathlib, uvicorn; from piano_duet import server; "
    + "root = pathlib.Path(sys.argv[2]); server.SAMPLES = root; server.NOTATION = root; "
    + "uvicorn.run(server.create_app(profile_path=root / 'profile.sqlite3'), host='127.0.0.1', "
    + "port=int(sys.argv[1]), lifespan='off', log_level='error')";
  const server = spawn("uv", ["run", "--frozen", "python", "-c", code, String(port), directory],
    {stdio: ["ignore", "pipe", "pipe"]});
  await waitForServer(server, port, "Python reference server");
  return {server, port};
}
