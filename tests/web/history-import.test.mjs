import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {startTestServer} from './server.mjs';

let server, port, directory, path;
before(async () => {
  await mkdir('.local', {recursive: true});
  directory = await mkdtemp('.local/history-browser-');
  path = `${directory}/learner.sqlite3`;
  const fixture = spawnSync('uv', ['run', '--frozen', 'python', 'tests/core/history_fixture.py', path], {encoding: 'utf8', maxBuffer: 20000000});
  assert.equal(fixture.status, 0, fixture.stderr);
  ({server, port} = await startTestServer());
}, {timeout: 120000});
after(async () => { server?.kill('SIGTERM'); if (directory) await rm(directory, {recursive: true, force: true}); });
for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${name} imports Mac history through the profile and skips a second import`, {timeout: 120000}, async () => {
    const profile = await mkdtemp('.local/history-browser-profile-');
    const browser = await engine.launchPersistentContext(profile, {headless: true});
    try {
      const bytes = Buffer.alloc(1644);
      bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
      bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
      bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
      bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
      const sample = {pitch: 60, file: 'C4.mp3', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
      await browser.route('**/src/piano-samples.ts', route => route.fulfill({contentType: 'text/javascript', body: `export const SAMPLE_REVISION = "revision-a"; export const PIANO_SAMPLES = ${JSON.stringify([sample])};`}));
      await browser.route('https://raw.githubusercontent.com/**/revision-a/samples/piano/C4.mp3', route => route.fulfill({body: bytes, headers: {'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'}}));
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => document.querySelector('#practiceTitle')?.textContent === 'C major scale', null, {timeout: 30000});
      await page.locator('#openProfile').click();
      await page.locator('#historyFile').setInputFiles(path);
      await page.waitForFunction(() => /Imported \d+ new events/.test(document.querySelector('#historyImportStatus')?.textContent ?? ''), null, {timeout: 30000});
      assert.match(await page.locator('#historyImportStatus').textContent(), /12 attempts/);
      assert.match(await page.locator('#profileSummary').textContent(), /11 included attempts/);
      await page.locator('#historyFile').setInputFiles(path);
      await page.waitForFunction(() => document.querySelector('#historyImportStatus')?.textContent?.startsWith('Imported 0 new events'), null, {timeout: 30000});
      await page.reload();
      await page.locator('#openProfile').click();
      await page.waitForFunction(() => document.querySelector('#profileSummary')?.textContent?.includes('11 included attempts'));
    } finally { await browser.close(); await rm(profile, {recursive: true, force: true}); }
  });
}
