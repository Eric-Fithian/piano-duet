import { Builder } from "selenium-webdriver";
import { startServer } from "./server.mjs";

const [model, backend, flag] = process.argv.slice(2);
if (!["aria", "transcription"].includes(model) || !["webgpu", "wasm", "split-fp32"].includes(backend)
    || (model === "aria" && backend.startsWith("split-"))
    || (flag !== undefined && flag !== "--verbose")) {
  throw new Error("Usage: node tests/inference/measure-safari.mjs <aria|transcription> <webgpu|wasm|split-fp32> [--verbose]");
}
const server = await startServer();
let driver;
try {
  driver = await new Builder().forBrowser("safari").build();
  await driver.manage().setTimeouts({ script: 900000 });
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  await driver.wait(async () => driver.executeScript("return typeof window.measure === 'function'"), 30000);
  const result = await driver.executeAsyncScript(function (modelName, provider, verbose, done) {
    window.measure(modelName, provider, verbose).then(
      (value) => done({ value }),
      (error) => done({ error: `${error.name}: ${error.message}\n${error.stack}` }),
    );
  }, model, backend, flag === "--verbose");
  if (result.error) throw new Error(result.error);
  console.log(JSON.stringify(result.value, null, 2));
} finally {
  if (driver) await driver.quit();
  await new Promise((resolve) => server.close(resolve));
}
