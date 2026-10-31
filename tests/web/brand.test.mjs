import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {startTestServer} from './server.mjs';

let dev, preview;
before(async () => {
  dev = await startTestServer();
  preview = await startTestServer(true);
}, {timeout: 45000});
after(() => { dev?.server.kill('SIGTERM'); preview?.server.kill('SIGTERM'); });

for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
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
      assert.equal(head.themes, 2);
      for (const filename of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
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
    await browser.close();
  });
}
