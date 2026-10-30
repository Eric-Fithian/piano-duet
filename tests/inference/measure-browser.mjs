import { chromium, webkit } from "playwright";
import { startServer } from "./server.mjs";

const [browserName, model, backend, flag] = process.argv.slice(2);
if (!["chrome", "webkit"].includes(browserName) || !["aria", "transcription"].includes(model)
    || !["webgpu", "wasm", "split-fp32"].includes(backend) || (model === "aria" && backend.startsWith("split-"))
    || (flag !== undefined && flag !== "--verbose")) {
  throw new Error("Usage: node tests/inference/measure-browser.mjs <chrome|webkit> <aria|transcription> <webgpu|wasm|split-fp32> [--verbose]");
}
const server = await startServer();
const browser = await (browserName === "chrome" ? chromium.launch({ channel: "chrome", headless: true }) : webkit.launch());
const page = await browser.newPage();
page.on("console", (message) => process.stderr.write(`${message.type()}: ${message.text()}\n`));
page.on("pageerror", (error) => process.stderr.write(`${error}\n`));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => typeof window.measure === "function");
const result = await page.evaluate(({ model, backend, verbose }) => window.measure(model, backend, verbose),
  { model, backend, verbose: flag === "--verbose" });
console.log(JSON.stringify(result, null, 2));
await browser.close();
await new Promise((resolve) => server.close(resolve));
