import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {startTestServer} from './server.mjs';

function sampleWave() {
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

let server, port;
before(async () => { ({server, port} = await startTestServer()); }, {timeout: 45000});
after(() => server.kill('SIGTERM'));
for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${name} opens the existing interface with a local practice task`, {timeout: 60000}, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'piano-duet-reference-ui-'));
    const browser = await engine.launchPersistentContext(profile, {headless: true,
      ...(name === 'Chromium' ? {args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']} : {})});
    try {
      const bytes = sampleWave();
      const sample = {pitch: 60, file: 'C4.mp3', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
      await browser.route('**/src/piano-samples.ts', route => route.fulfill({contentType: 'text/javascript',
        body: `export const SAMPLE_REVISION = "revision-a"; export const PIANO_SAMPLES = ${JSON.stringify([sample])};`}));
      await browser.route('https://raw.githubusercontent.com/**/revision-a/samples/piano/C4.mp3', route => route.fulfill({body: bytes,
        headers: {'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'}}));
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => document.querySelector('#practiceTitle')?.textContent === 'C major scale', null, {timeout: 30000});
      await page.locator('#sheetMusic svg').first().waitFor({timeout: 15000});
      assert.equal(await page.locator('#error').isHidden(), true);
      assert.equal(await page.locator('#openYoutube').isHidden(), true);
      assert.equal(await page.locator('.mode-switch button').count(), 6);
      await page.locator('#openProfile').click();
      assert.equal(await page.locator('#profileDialog').evaluate(dialog => dialog.open), true);
      assert.ok((await page.locator('#profileSummary').textContent()).includes('0 included attempts'));
      if (name === 'Chromium') {
        await page.locator('#profileDialog').evaluate(dialog => dialog.close());
        await browser.grantPermissions(['microphone'], {origin: `http://127.0.0.1:${port}`});
        await page.locator('#start').click();
        await page.waitForFunction(() => document.querySelector('#start').getAttribute('aria-pressed') === 'true', null, {timeout: 15000});
        assert.equal(await page.locator('#error').isHidden(), true);
      }
    } finally {
      await browser.close();
      await rm(profile, {recursive: true, force: true});
    }
  });
}
