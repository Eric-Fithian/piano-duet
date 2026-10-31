import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { waitForServer } from "./server.mjs";

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("server readiness waits for HTTP 200 after startup and temporary errors", async () => {
  const port = await unusedPort();
  const code = "const http = require('node:http'); let requests = 0; "
    + "setTimeout(() => http.createServer((req, res) => { requests++; "
    + "res.writeHead(requests < 3 ? 503 : 200); res.end(String(requests)); "
    + "}).listen(Number(process.argv[1]), '127.0.0.1'), 250)";
  const child = spawn(process.execPath, ["-e", code, String(port)], {stdio: ["ignore", "pipe", "pipe"]});
  const exited = once(child, "exit");
  try {
    await waitForServer(child, port, "Delayed server", 10000);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.ok(Number(await response.text()) >= 4);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
});

test("server readiness reports the process output on an early exit", async () => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["-e", "console.log('startup diagnostic'); process.exit(7)"], {stdio: ["ignore", "pipe", "pipe"]});
  const exited = once(child, "exit");
  await assert.rejects(waitForServer(child, port, "Broken server", 10000), (error) => {
    assert.ok(error.message.includes("exited before startup: 7"));
    assert.ok(error.message.includes("startup diagnostic"));
    return true;
  });
  await exited;
});

test("server readiness reports the process output when the deadline expires", async () => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["-e", "console.log('still starting'); setInterval(() => {}, 1000)"], {stdio: ["ignore", "pipe", "pipe"]});
  const exited = once(child, "exit");
  await assert.rejects(waitForServer(child, port, "Slow server", 1500), (error) => {
    assert.ok(error.message.includes("did not return HTTP 200 within 1500 ms"));
    assert.ok(error.message.includes("still starting"));
    return true;
  });
  await exited;
});
