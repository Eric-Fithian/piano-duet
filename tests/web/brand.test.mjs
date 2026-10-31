import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {startReferenceServer, startTestServer} from './server.mjs';

let dev, preview, reference, directory;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'piano-brand-'));
  dev = await startTestServer(false, 0, 120000);
  preview = await startTestServer(true, 0, 120000);
  reference = await startReferenceServer(directory);
}, {timeout: 390000});
after(async () => { dev?.server.kill('SIGTERM'); preview?.server.kill('SIGTERM'); reference?.server.kill('SIGTERM'); await rm(directory, {recursive: true, force: true}); });

for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${name} applies saved appearance before rendering in both builds`, {timeout: 60000}, async () => {
    const browser = await engine.launch();
    const tokens = JSON.parse(await readFile('design/brand/tokens.json', 'utf8'));
    const cases = [
      {system: 'dark', preference: null, night: null, theme: 'dark', page: 'false'},
      {system: 'light', preference: null, night: null, theme: 'light', page: 'false'},
      {system: 'light', preference: 'dark', night: 'true', theme: 'dark', page: 'true'},
      {system: 'dark', preference: 'light', night: 'false', theme: 'light', page: 'false'},
    ];
    for (const server of [reference, dev, preview]) for (const entry of cases) {
      const context = await browser.newContext({colorScheme: entry.system});
      await context.addInitScript(({preference, night}) => {
        if (preference !== null) localStorage.setItem('piano-duet-theme', preference);
        if (night !== null) localStorage.setItem('piano-duet-night-page', night);
        const observer = new MutationObserver(() => {
          if (!document.body) return;
          window.appearanceAtBody = {theme: document.documentElement.dataset.theme, night: document.documentElement.dataset.night,
            color: document.querySelector('meta[name="theme-color"]').content};
          observer.disconnect();
        });
        observer.observe(document, {childList: true, subtree: true});
      }, entry);
      await context.route('**/*', route => {
        const request = route.request();
        if (request.resourceType() === 'script' && !new URL(request.url()).pathname.endsWith('/appearance-bootstrap.js')) {
          return route.fulfill({contentType: 'text/javascript', body: ''});
        }
        return route.continue();
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`, {waitUntil: 'load'});
      await page.waitForFunction(() => window.appearanceAtBody);
      const state = await page.evaluate(() => ({atBody: window.appearanceAtBody,
        theme: document.documentElement.dataset.theme, night: document.documentElement.dataset.night,
        color: document.querySelector('meta[name="theme-color"]').content}));
      const expected = {theme: entry.theme, night: entry.page, color: tokens[entry.theme].bg};
      assert.deepEqual(state.atBody, expected);
      assert.deepEqual({theme: state.theme, night: state.night, color: state.color}, expected);
      if (server !== dev) {
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--folio-bg').trim()), expected.color);
      }
      await context.close();
    }
    await browser.close();
  });

  test(`${name} serves the signed-off brand assets in development and production`, {timeout: 45000}, async () => {
    const browser = await engine.launch();
    const page = await browser.newPage();
    for (const server of [dev, preview]) {
      const root = `http://127.0.0.1:${server.port}`;
      const html = await (await page.request.get(`${root}/`)).text();
      const head = await page.evaluate(source => {
        const doc = new DOMParser().parseFromString(source, 'text/html');
        return {manifest: doc.querySelector('link[rel="manifest"]').getAttribute('href'),
          image: doc.querySelector('meta[property="og:image"]').getAttribute('content'),
          themes: doc.querySelectorAll('meta[name="theme-color"]').length};
      }, html);
      assert.equal(head.manifest, '/static/brand/manifest.webmanifest');
      assert.equal(head.image, 'https://piano-duet.vercel.app/docs/og.png');
      assert.equal(head.themes, 1);
      const bootstrap = await page.request.get(`${root}/static/appearance-bootstrap.js`);
      assert.equal(bootstrap.status(), 200);
      assert.deepEqual(await bootstrap.body(), await readFile('src/piano_duet/static/appearance-bootstrap.js'));
      for (const filename of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'wordmark-horizontal-header-light.svg', 'wordmark-horizontal-header-dark.svg']) {
        const response = await page.request.get(`${root}/static/brand/${filename}`);
        assert.equal(response.status(), 200, filename);
        assert.deepEqual(await response.body(), await readFile(`design/brand/assets/${filename}`));
      }
      const manifestUrl = `${root}/static/brand/manifest.webmanifest`;
      const manifestResponse = await page.request.get(manifestUrl);
      assert.equal(manifestResponse.status(), 200);
      const manifest = await manifestResponse.json();
      assert.equal(manifest.start_url, '/');
      assert.deepEqual(new Set(manifest.icons.map(icon => icon.purpose)), new Set(['any', 'maskable', 'monochrome']));
      for (const icon of manifest.icons) {
        const response = await page.request.get(new URL(icon.src, manifestUrl).href);
        assert.equal(response.status(), 200, icon.src);
        assert.deepEqual(await response.body(), await readFile(`design/brand/assets/${icon.src.slice(2)}`));
      }
    }
    const root = `http://127.0.0.1:${preview.port}`;
    await page.goto(`${root}/docs/`, {waitUntil: 'domcontentloaded'});
    for (const selector of ['link[rel="shortcut icon"]', 'link[rel="alternate icon"]', 'link[rel="apple-touch-icon"]', 'link[rel="manifest"]']) {
      const href = await page.locator(selector).first().getAttribute('href');
      const response = await page.request.get(new URL(href, `${root}/docs/`).href);
      assert.equal(response.status(), 200, href);
      assert.ok((await response.body()).length > 100, href);
    }
    const docsManifestUrl = `${root}/docs/brand/manifest.webmanifest`;
    const docsManifest = await (await page.request.get(docsManifestUrl)).json();
    for (const icon of docsManifest.icons) {
      const response = await page.request.get(new URL(icon.src, docsManifestUrl).href);
      assert.equal(response.status(), 200, icon.src);
      assert.deepEqual(await response.body(), await readFile(`design/brand/assets/${icon.src.slice(2)}`));
    }
    const images = await page.locator('main img').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
    assert.ok(images.length >= 3, 'The docs landing page must retain its product images');
    for (const src of images) {
      const response = await page.request.get(new URL(src, `${root}/docs/`).href);
      assert.equal(response.status(), 200, src);
      assert.ok(response.headers()['content-type'].startsWith('image/'), src);
    }
    assert.deepEqual(await (await page.request.get(`${root}/docs/og.png`)).body(), await readFile('design/brand/assets/og-image.png'));
    assert.ok((await readFile('site/dist/service-worker.js', 'utf8')).includes('/static/brand/manifest.webmanifest'));
    assert.ok((await readFile('site/dist/service-worker.js', 'utf8')).includes('/static/appearance-bootstrap.js'));
    await browser.close();
  });
}
