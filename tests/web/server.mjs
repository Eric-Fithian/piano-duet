import { spawn } from "node:child_process";
import { get } from "node:http";
import { createServer } from "node:net";
import { resolve } from "node:path";

export async function startTestServer(preview = false, requestedPort = 0) {
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
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  server.stdout.on("data", () => {});
  await new Promise((ready, reject) => {
    const deadline = Date.now() + 30000;
    let last = "connection refused";
    const fail = (error) => { server.kill("SIGTERM"); reject(error); };
    server.once("error", fail);
    server.once("exit", (code) => fail(new Error(`Vite exited before startup: ${code}`)));
    const poll = () => {
      if (Date.now() >= deadline) return fail(new Error(`Vite did not respond on port ${port} within 30 seconds: ${last}`));
      const request = get(`http://127.0.0.1:${port}/`, (response) => {
        response.resume();
        if (response.statusCode === 200) ready();
        else { last = `HTTP ${response.statusCode}`; setTimeout(poll, 100); }
      });
      request.on("error", (error) => {
        if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code)) { last = error.message; setTimeout(poll, 100); }
        else fail(error);
      });
      request.setTimeout(1000, () => request.destroy(Object.assign(new Error("Vite startup request timed out"), { code: "ETIMEDOUT" })));
    };
    poll();
  });
  return { server, port };
}

export async function enableAllModes(context) {
  await context.route('**/enabled_modes.mjs*', route => route.fulfill({contentType: 'text/javascript',
    body: "export const ENABLED_MODES = ['practice', 'reading', 'drills', 'library', 'duet', 'learning'];"}));
}
