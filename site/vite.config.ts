import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: "app",
  publicDir: false,
  build: { outDir: "../dist", emptyOutDir: true, assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"],
    include: ["@noble/hashes/sha2.js", "@noble/hashes/utils.js", "onnxruntime-web/webgpu"] },
  server: { host: "127.0.0.1", headers, fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] }, proxy: {
    "/docs": "http://127.0.0.1:4321",
    "/install.sh": { target: "http://127.0.0.1:4321", rewrite: () => "/docs/install.sh" },
  } },
  preview: { host: "127.0.0.1", headers, proxy: {} },
  worker: { format: "es" },
  plugins: [{
    name: "reference-interface",
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        if (context.path !== "/" && context.path !== "/index.html") return html;
        html = readFileSync(new URL("../src/piano_duet/static/index.html", import.meta.url), "utf8");
        const replace = (before: string, after: string) => {
          if (html.split(before).length !== 2) throw new Error(`Expected exactly one reference interface element: ${before}`);
          html = html.replace(before, after);
        };
        for (const file of ["style.css", "score.css", "practice.css", "game.css"]) {
          replace(`  <link rel="stylesheet" href="/static/${file}">\n`, "");
        }
        replace('  <script src="/notation-assets/vexflow.js" defer></script>\n', "");
        replace('  <script type="module" src="/static/app.mjs"></script>', '  <script type="module" src="/src/main.ts"></script>');
        replace('href="/static/credits.html"', 'href="/docs/credits/"');
        replace('id="openYoutube" class=', 'id="openYoutube" hidden class=');
        replace('        <div class="song-table" role="table" aria-label="Your songs">',
          '        <div class="recording-import" aria-label="Recording import"><button class="secondary" type="button" disabled>Import audio</button><button class="secondary" type="button" disabled>Record audio</button><p id="recordingImportStatus">Score writing for audio files and recordings is unavailable for now.</p></div>\n        <div class="song-table" role="table" aria-label="Your songs">');
        return html;
      },
    },
  }, {
    name: "offline-app-shell",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((name) => !name.endsWith(".map")).sort();
      const digest = createHash("sha256");
      digest.update(readFileSync(new URL("../src/piano_duet/static/index.html", import.meta.url)));
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
