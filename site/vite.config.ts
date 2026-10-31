import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
const brandDir = fileURLToPath(new URL("../src/piano_duet/static/brand/", import.meta.url));
const brandTypes: Record<string, string> = { ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png", ".webmanifest": "application/manifest+json" };

export default defineConfig({
  root: "app",
  resolve: { dedupe: ["@xmldom/xmldom", "fflate"] },
  publicDir: false,
  build: { outDir: "../dist", emptyOutDir: true, assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"],
    include: ["@noble/hashes/sha2.js", "@noble/hashes/utils.js", "mediabunny", "onnxruntime-web/webgpu"] },
  server: { host: "127.0.0.1", headers, fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] }, proxy: {
    "/docs": "http://127.0.0.1:4321",
    "/install.sh": { target: "http://127.0.0.1:4321", rewrite: () => "/docs/install.sh" },
  } },
  preview: { host: "127.0.0.1", headers, proxy: {} },
  worker: { format: "es" },
  plugins: [{
    name: "sync-configuration",
    buildStart() {
      const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey } = process.env;
      if ((url === undefined) !== (anonKey === undefined) || (url !== undefined && (!url.trim() || !anonKey?.trim()))) {
        throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set together");
      }
      for (const name of ["SUPABASE_EMAIL_ENABLED", "SUPABASE_GOOGLE_ENABLED"]) {
        const value = process.env[name];
        if (value !== undefined && value !== "true" && value !== "false") {
          throw new Error(`${name} must be true or false`);
        }
      }
    },
    generateBundle() {
      const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey } = process.env;
      if (url && anonKey) this.emitFile({ type: "asset", fileName: "sync-config.json", source: JSON.stringify({
        url, anonKey, emailEnabled: process.env.SUPABASE_EMAIL_ENABLED === "true",
        providers: process.env.SUPABASE_GOOGLE_ENABLED === "true" ? ["google"] : [],
      }) });
    },
  }, {
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
        for (const file of ["style.css", "score.css", "practice.css", "game.css", "chrome.css", "progress.css"]) {
          replace(`  <link rel="stylesheet" href="/static/${file}">\n`, "");
        }
        replace('  <script src="/notation-assets/vexflow.js" defer></script>\n', "");
        replace('  <script type="module" src="/static/app.mjs"></script>', '  <script type="module" src="/src/main.ts"></script>');
        replace('href="/static/credits.html"', 'href="/docs/credits/"');
        replace('<button id="openYoutube"', '<button id="importAudio" type="button">Audio file</button><button id="recordAudio" type="button">Record audio</button><button id="openYoutube"');
        replace('>From YouTube</button></div></details>', '>From YouTube link</button></div></details>');
        replace('      <button id="youtubeGo" class="primary" type="submit">Transcribe</button>', `      <label>Title <input id="youtubeVideoTitle" type="text" maxlength="200" value="YouTube recording" required></label>
      <label>Channel (optional) <input id="youtubeChannel" type="text" maxlength="200"></label>
      <p class="setting-help">Choose the YouTube tab and keep “Also share tab audio” checked. Start the video after sharing begins; capture happens in real time.</p>
      <button id="youtubeGo" class="primary" type="submit">Start</button><button id="youtubeStop" class="secondary" type="button" hidden>Stop and write score</button>
      <p id="youtubeSupport" role="status" hidden></p><button id="youtubeRecord" class="secondary" type="button" hidden>Record with microphone</button>`);
        replace('      <h3>Listening</h3>', `      <h3>Account and sync</h3><section id="accountSync" aria-label="Account and sync"></section>
      <details class="history-import"><summary>Import history from the Mac app</summary><p>Quit the Mac app before selecting its .local/learner.sqlite3 file, so all history is saved in the file.</p><label class="secondary">Choose history file <input id="historyFile" type="file" accept=".sqlite3,.sqlite,.db"></label><progress id="historyImportProgress" aria-label="Importing history" hidden></progress><p id="historyImportStatus" aria-live="polite"></p></details>
      <h3>Listening</h3>`);
        replace('        <div class="song-table" role="table" aria-label="Your songs">',
          `        <p id="recordingImportStatus" aria-live="polite"></p>
        <dialog id="recordingDialog" class="settings-dialog" aria-labelledby="recordingTitle"><div class="dialog-heading"><h2 id="recordingTitle">Import a recording</h2><button id="recordingClose" class="quiet-button" type="button">Done</button></div>
        <form id="recordingForm" class="controls youtube-form"><label id="recordingFileLabel">Audio file <input id="recordingFile" type="file" accept="audio/*"></label>
        <button id="recordingToggle" class="secondary" type="button" hidden>Start recording</button><p id="recordingSelection" aria-live="polite"></p>
        <label class="youtube-rights"><input id="recordingRights" type="checkbox" required> I own this recording, or have permission from its rights holder to transcribe it, and will use the score only for my own practice.</label>
        <button id="recordingGo" class="primary" type="submit">Write score</button><p id="recordingStage" aria-live="polite"></p><p id="recordingError" class="youtube-error" role="alert" hidden></p><p class="setting-help">Solo piano recordings work best.</p></form></dialog>
        <div class="song-table" role="table" aria-label="Your songs">`);
        return html;
      },
    },
  }, {
    name: "brand-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0];
        if (!path?.startsWith("/static/brand/")) return next();
        const name = path.slice("/static/brand/".length);
        if (!readdirSync(brandDir).includes(name)) { response.writeHead(404).end(); return; }
        const type = brandTypes[extname(name)];
        if (!type) throw new Error(`Unknown brand asset type: ${name}`);
        response.setHeader("Content-Type", type);
        response.end(readFileSync(join(brandDir, name)));
      });
    },
    generateBundle() {
      for (const name of readdirSync(brandDir)) {
        if (!brandTypes[extname(name)]) throw new Error(`Unknown brand asset type: ${name}`);
        this.emitFile({ type: "asset", fileName: `static/brand/${name}`, source: readFileSync(join(brandDir, name)) });
      }
    },
  }, {
    name: "appearance-bootstrap",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/static/appearance-bootstrap.js") return next();
        response.setHeader("Content-Type", "text/javascript");
        response.end(readFileSync(new URL("../src/piano_duet/static/appearance-bootstrap.js", import.meta.url)));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "static/appearance-bootstrap.js",
        source: readFileSync(new URL("../src/piano_duet/static/appearance-bootstrap.js", import.meta.url)) });
    },
  }, {
    name: "offline-app-shell",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((name) => !name.endsWith(".map") && name !== "sync-config.json").sort();
      const digest = createHash("sha256");
      digest.update(readFileSync(new URL("../src/piano_duet/static/index.html", import.meta.url)));
      for (const name of files) {
        const entry = bundle[name];
        digest.update(name).update(entry.type === "asset" ? entry.source : entry.code);
      }
      const cache = `piano-duet-shell-${digest.digest("hex").slice(0, 16)}`;
      const script = `const CACHE = ${JSON.stringify(cache)};\nconst FILES = ${JSON.stringify(["/index.html", ...files.map((name) => `/${name}`)])};\n`
        + `self.addEventListener('install', event => event.waitUntil((async () => { const cache = await caches.open(CACHE); for (const file of FILES) { const response = await fetch(file).catch(error => { throw new Error('Offline download failed for ' + file + ': ' + error, { cause: error }); }); const detail = { url: response.url, status: response.status, type: response.type, redirected: response.redirected, coep: response.headers.get('cross-origin-embedder-policy'), corp: response.headers.get('cross-origin-resource-policy') }; console.info('Offline asset', detail); if (!response.ok || response.redirected) throw new Error('Offline download failed: ' + JSON.stringify(detail)); await cache.put(file, response).catch(error => { throw new Error('Offline cache failed: ' + JSON.stringify(detail) + ': ' + error, { cause: error }); }); } })().catch(async error => { const message = { type: 'offline-install-error', error: String(error) }; for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage(message); throw error; })));\n`
        + `self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('piano-duet-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));\n`
        + `self.addEventListener('fetch', event => { const url = new URL(event.request.url); if (event.request.method !== 'GET' || url.origin !== self.location.origin) return; const path = url.pathname === '/' ? '/index.html' : url.pathname; if (FILES.includes(path)) event.respondWith(caches.open(CACHE).then(cache => cache.match(path)).then(response => response || fetch(event.request))); });\n`;
      this.emitFile({ type: "asset", fileName: "service-worker.js", source: script });
    },
  }],
});
