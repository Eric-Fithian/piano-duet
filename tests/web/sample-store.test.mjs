import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {startTestServer} from './server.mjs';

let server, port;
before(async () => { ({server, port} = await startTestServer()); }, {timeout: 45000});
after(() => server.kill('SIGTERM'));
for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${name} caches verified piano samples for offline use`, {timeout: 45000}, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'piano-duet-samples-'));
    const browser = await engine.launchPersistentContext(profile, {headless: true});
    try {
      const bytes = Buffer.from('sample fixture');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      let downloads = 0;
      await browser.route('https://raw.githubusercontent.com/**/revision-a/samples/piano/C4.mp3', async route => {
        downloads++;
        await route.fulfill({body: bytes, headers: {'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'}});
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/test/sample-store.html`);
      await page.waitForFunction(() => typeof window.createSampleStore === 'function');
      const sample = {pitch: 60, file: 'C4.mp3', sha256, bytes: bytes.length};
      const first = await page.evaluate(async sample => {
        window.progress = [];
        window.samples = window.createSampleStore(entry => window.progress.push(entry), [sample], 'revision-a');
        const manifest = await (await window.samples.fetch('/samples/manifest.json')).json();
        const content = await (await window.samples.fetch('/samples/C4.mp3')).text();
        return {manifest, content, progress: window.progress};
      }, sample);
      assert.deepEqual(first.manifest, [sample]);
      assert.equal(first.content, 'sample fixture');
      assert.equal(first.progress.at(-1).received, bytes.length);
      await browser.setOffline(true);
      assert.equal(await page.evaluate(async () => (await window.samples.fetch('/samples/C4.mp3')).text()), 'sample fixture');
      assert.equal(downloads, 1);
    } finally {
      await browser.close();
      await rm(profile, {recursive: true, force: true});
    }
  });
}
