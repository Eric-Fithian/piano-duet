import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: "app",
  publicDir: false,
  build: { outDir: "../dist", emptyOutDir: true },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"],
    include: ["@noble/hashes/sha2.js", "@noble/hashes/utils.js", "onnxruntime-web/webgpu"] },
  server: { host: "127.0.0.1", headers, proxy: {
    "/docs": "http://127.0.0.1:4321",
    "/install.sh": { target: "http://127.0.0.1:4321", rewrite: () => "/docs/install.sh" },
  } },
  preview: { host: "127.0.0.1", headers },
  worker: { format: "es" },
  plugins: [{
    name: "offline-app-shell",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((name) => !name.endsWith(".map")).sort();
      const digest = createHash("sha256");
      digest.update(readFileSync(new URL("./app/index.html", import.meta.url)));
      for (const name of files) {
        const entry = bundle[name];
        digest.update(name).update(entry.type === "asset" ? entry.source : entry.code);
      }
      const cache = `piano-duet-shell-${digest.digest("hex").slice(0, 16)}`;
      const script = `const CACHE = ${JSON.stringify(cache)};\nconst FILES = ${JSON.stringify(["/index.html", ...files.map((name) => `/${name}`)])};\n`
        + `self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));\n`
        + `self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('piano-duet-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));\n`
        + `self.addEventListener('fetch', event => { const url = new URL(event.request.url); if (event.request.method !== 'GET' || url.origin !== self.location.origin) return; const path = url.pathname === '/' ? '/index.html' : url.pathname; if (FILES.includes(path)) event.respondWith(caches.open(CACHE).then(cache => cache.match(path)).then(response => response || fetch(event.request))); });\n`;
      this.emitFile({ type: "asset", fileName: "service-worker.js", source: script });
    },
  }],
});
