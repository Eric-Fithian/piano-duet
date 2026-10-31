import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {strToU8, zipSync} from 'fflate';
import {startTestServer, enableAllModes} from './server.mjs';

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
      await enableAllModes(browser);
      const bytes = sampleWave();
      const sample = {pitch: 60, file: 'C4.mp3', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
      await browser.route('**/src/piano-samples.ts', route => route.fulfill({contentType: 'text/javascript',
        body: `export const SAMPLE_REVISION = "revision-a"; export const PIANO_SAMPLES = ${JSON.stringify([sample])};`}));
      await browser.route('https://raw.githubusercontent.com/**/revision-a/samples/piano/C4.mp3', route => route.fulfill({body: bytes,
        headers: {'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'}}));
      await browser.route('**/src/browser-recording-import.ts', route => route.fulfill({contentType: 'text/javascript', body: 'export class BrowserRecordingImporter { async prepare() {} }'}));
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
      await page.locator('#profileDialog').evaluate(dialog => dialog.close());
      await page.locator('#modeMenuButton').click();
      await page.locator('#libraryMode').click();
      await page.locator('#importMenu > summary').click();
      assert.equal(await page.locator('#importAudio').isVisible(), true);
      assert.equal(await page.locator('#recordAudio').isVisible(), true);
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#chooseScore').click();
      assert.equal((await chooser).isMultiple(), false);
      await page.locator('#importMenu > summary').click();
      await page.locator('#recordAudio').click();
      assert.equal(await page.locator('#recordingToggle').isVisible(), true);
      await page.locator('#recordingClose').click();
      const score = '<score-partwise><work><work-title>Browser test song</work-title></work><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>';
      await page.locator('#libraryFile').setInputFiles({name: 'test.musicxml', mimeType: 'application/xml', buffer: Buffer.from(score)});
      await page.getByText('Browser test song', {exact: true}).waitFor({timeout: 15000});
      const midi = Buffer.from('4d546864000000060000000101e04d54726b0000000d00903c508360803c0000ff2f00', 'hex');
      await page.locator('#libraryFile').setInputFiles({name: 'Browser MIDI.mid', mimeType: 'audio/midi', buffer: midi});
      await page.getByText('Browser MIDI', {exact: true}).waitFor({timeout: 15000});
      const container = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>';
      const mxl = zipSync({'META-INF/container.xml': strToU8(container), 'score.musicxml': strToU8(score.replace('Browser test song', 'Packed test song'))});
      await page.locator('#libraryFile').setInputFiles({name: 'test.mxl', mimeType: 'application/zip', buffer: Buffer.from(mxl)});
      await page.getByText('Packed test song', {exact: true}).waitFor({timeout: 15000});
      await page.getByRole('button', {name: 'Open Browser test song'}).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.classList.contains('song-open'));
      assert.equal(await page.locator('#songTitle').textContent(), 'Browser test song');
      await page.locator('#songEdit').click();
      assert.equal(await page.locator('#songEditBar').isVisible(), true);
      await page.locator('#editCancel').click();
      await page.locator('#songBack').click();
      await page.reload();
      await page.getByText('Browser test song', {exact: true}).waitFor({timeout: 15000});
      await page.locator('#modeMenuButton').click();
      await page.locator('#drillsMode').click();
      await page.waitForFunction(() => document.querySelector('#drillTitle')?.textContent?.includes('five-finger pattern'), null, {timeout: 30000});
      assert.equal(await page.locator('#error').isHidden(), true);
      await page.locator('#modeMenuButton').click();
      await page.locator('#readingMode').click();
      await page.waitForFunction(() => document.querySelector('#practiceTitle')?.textContent?.includes('Meet'), null, {timeout: 30000});
      await page.locator('#sheetMusic svg').first().waitFor({timeout: 15000});
      assert.equal(await page.locator('#error').isHidden(), true);
      if (name === 'Chromium') {
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
