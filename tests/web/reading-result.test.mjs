import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {after, before, test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium, webkit} from 'playwright';
import {startTestServer} from './server.mjs';

const bytes = Buffer.alloc(1644);
bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
const sample = {pitch: 60, file: 'C4.mp3', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
let server, port;
before(async () => { ({server, port} = await startTestServer()); }, {timeout: 45000});
after(() => server?.kill('SIGTERM'));

const captureTheme = process.env.PROGRESS_THEME ?? 'light';
if (!['light', 'dark', 'night'].includes(captureTheme)) throw new Error(`Unknown capture theme ${captureTheme}`);
const themes = [[captureTheme === 'night' ? 'dark' : captureTheme, captureTheme === 'night']];
for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) for (const [theme, night] of themes) {
  const captureName = `${name.toLowerCase()}-${night ? 'night' : theme}`;
  test(`${name} ${night ? 'night' : theme} keeps the completed score for review, retry, and next score`, {timeout: 60000}, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'piano-result-'));
    const context = await engine.launchPersistentContext(profile, {headless: true, viewport: {width: 393, height: 852}});
    try {
      await context.route('**/src/piano-samples.ts', route => route.fulfill({contentType: 'text/javascript', body: `export const SAMPLE_REVISION = "result-fixture"; export const PIANO_SAMPLES = ${JSON.stringify([sample])};`}));
      await context.route('https://raw.githubusercontent.com/**/result-fixture/samples/piano/C4.mp3', route => route.fulfill({body: bytes, headers: {'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'}}));
      await context.route('**/src/browser-inference.ts', route => route.fulfill({contentType: 'text/javascript', body: 'export class BrowserInference { async createSession(model) { return {model, provider: "wasm", run: async () => model === "aria" ? {logits: new Float32Array(18000)} : {notes: []}}; } }'}));
      await context.route('**/src/browser-recording-import.ts', route => route.fulfill({contentType: 'text/javascript', body: 'export class BrowserRecordingImporter { async prepare() {} }'}));
      // Expose the live stream to feed deterministic recognized notes; rendering and controls stay production code.
      await context.route('**/static/app.mjs*', async route => {
        const response = await route.fetch();
        let source = await response.text();
        const needle = 'const reading = new ReadingStream({';
        const save = "const result = await localRequest('/api/reading/complete', {";
        assert.equal(source.split(needle).length, 2);
        assert.equal(source.split(save).length, 2);
        source = source.replace(needle, 'const reading = window.testReadingStream = new ReadingStream({');
        source = source.replace(save, `await window.testReadingSaveGate?.(); ${save}`);
        await route.fulfill({response, body: source});
      });
      const page = await context.newPage();
      await page.addInitScript(({theme, night}) => {
        localStorage.setItem('piano-duet-theme', theme);
        localStorage.setItem('piano-duet-night-page', String(night));
        Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {configurable: true, value: async () => {
          const audio = new AudioContext();
          await audio.resume();
          return audio.createMediaStreamDestination().stream;
        }});
        Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'enumerateDevices', {configurable: true, value: async () => []});
      }, {theme, night});
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${port}/`);
      try {
        await page.waitForFunction(() => (window.testReadingStream?.progress && document.querySelector('#sheetMusic svg'))
          || document.querySelector('#error:not([hidden]), #scoreError:not([hidden])'), null, {timeout: 30000});
      } catch (error) {
        const state = await page.evaluate(() => ({message: document.querySelector('#error').textContent,
          scoreError: document.querySelector('#scoreError').textContent, stream: Boolean(window.testReadingStream?.progress),
          score: Boolean(document.querySelector('#sheetMusic svg'))}));
        throw new Error(`Reading did not start: ${JSON.stringify({state, errors})}`, {cause: error});
      }
      assert.equal(await page.locator('#error').isHidden(), true, await page.locator('#error').innerText());
      assert.equal(await page.locator('#scoreError').isHidden(), true, await page.locator('#scoreError').innerText());
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#sheetMusic .score-system svg .vf-stavenote').first().waitFor();
      async function resize(width, height) {
        const previous = await page.locator('#sheetMusic .score-system svg').first().elementHandle();
        await page.setViewportSize({width, height});
        await page.waitForFunction(svg => !svg.isConnected, previous, {timeout: 10000});
        await page.locator('#sheetMusic .score-system svg .vf-stavenote').first().waitFor();
      }
      async function capture(state) {
        if (!process.env.PROGRESS_SCREENSHOTS) return;
        await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-portrait-${state}.png`});
        for (const [view, width, height] of [['landscape', 852, 393], ['desktop', 1440, 900]]) {
          await resize(width, height);
          await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-${view}-${state}.png`});
        }
        await resize(393, 852);
      }
      await capture('idle');
      await page.locator('#openProfile').click();
      await page.waitForFunction(() => document.querySelector('#readingProgressDialog').open);
      assert.equal(await page.locator('#readingPath .stage-dot').count(), 24);
      assert.equal(await page.locator('#readingPath .stage-dot').evaluateAll(nodes => nodes.every(node => {
        const box = node.getBoundingClientRect();
        return box.width >= 44 && box.height >= 44;
      })), true);
      if (process.env.PROGRESS_SCREENSHOTS) await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-portrait-progress.png`});
      await page.locator('[data-close="readingProgressDialog"]').click();
      await page.waitForFunction(() => !document.querySelector('#start').disabled);
      await page.locator('#start').click();
      await page.waitForFunction(() => document.querySelector('#start').getAttribute('aria-pressed') === 'true');
      const statusBefore = await page.locator('#noteStatus').boundingBox();
      const scoreBefore = await page.locator('#sheetPanel').boundingBox();
      assert.equal(statusBefore.height, 18);
      assert.equal(await page.locator('#openProfile').isVisible(), false);
      await page.evaluate(async () => {
        const stream = window.testReadingStream;
        const pitch = stream.progress.target[0].pitch;
        await stream.accept([{pitch: pitch > 106 ? pitch - 2 : pitch + 2, start: .7, velocity: 80, confidence: .95}], 0, 100, stream.generation, 100);
      });
      await page.locator('#sheetMusic .score-mark-cross').first().waitFor();
      assert.equal((await page.locator('#noteStatus').boundingBox()).height, 18);
      assert.equal((await page.locator('#sheetPanel').boundingBox()).y, scoreBefore.y);
      assert.ok((await page.locator('#noteStatus').innerText()).includes('expected'));
      assert.equal(await page.locator('#hudStreak').isVisible(), false);
      await capture('playing');
      const first = await page.evaluate(async () => {
        const stream = window.testReadingStream;
        const target = stream.progress.target;
        const groups = stream.progress.attacks.map((attack, i) => attack.indices.map(index => ({pitch: target[index].pitch, start: 1 + i * .4, velocity: 80, confidence: .95})));
        window.testReadingSaveGate = () => new Promise(resolve => { window.releaseReadingSave = resolve; });
        window.testCompletion = stream.accept(groups.flat(), 0, 100, stream.generation, 100);
        return target.map(note => note.pitch);
      });
      await page.waitForFunction(() => typeof window.releaseReadingSave === 'function');
      assert.equal(await page.locator('#start').isDisabled(), true);
      await page.evaluate(async () => {
        delete window.testReadingSaveGate;
        window.releaseReadingSave();
        await window.testCompletion;
      });
      await page.locator('#readingResultTray').waitFor({state: 'visible'});
      await page.locator('#sheetMusic .score-mark-cross').first().waitFor();
      await capture('result');
      if (process.env.PROGRESS_SCREENSHOTS) {
        await page.emulateMedia({reducedMotion: 'reduce'});
        assert.equal(await page.locator('.progress-ring-fill').evaluate(node => getComputedStyle(node).animationName), 'none');
        await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-portrait-reduced-motion.png`});
      }
      assert.ok(await page.locator('#sheetMusic .score-mark-cross').count() > 0);
      assert.ok(await page.locator('#sheetMusic .score-mark-check').count() > 0);
      const streak = page.locator('#hudStreak');
      assert.equal(await streak.isVisible(), true);
      assert.ok((await streak.innerText()).includes('first-try notes in a row'));
      assert.equal(await streak.locator('ellipse').first().evaluate(node => {
        const head = node.getBoundingClientRect(), svg = node.ownerSVGElement.getBoundingClientRect();
        return head.width > 2 && head.height > 2 && head.left >= svg.left - 1 && head.right <= svg.right + 1
          && getComputedStyle(node).fill !== 'none' && Number(getComputedStyle(node).fillOpacity) >= .75;
      }), true);
      const resultText = await page.locator('#readingResultTray').innerText();
      assert.ok(resultText.includes('expected') && resultText.includes('heard'));
      assert.equal(await page.locator('.reading-result-actions button').count(), 2);
      assert.ok((await page.getByRole('button', {name: 'Review', exact: true}).boundingBox()).height >= 44);
      const scoreBounds = await page.locator('#sheetPanel').boundingBox();
      const trayBounds = await page.locator('#readingResultTray').boundingBox();
      assert.ok(trayBounds.y >= scoreBounds.y + scoreBounds.height - 1);
      await resize(360, 800);
      const layout = await page.evaluate(() => {
        const header = document.querySelector('.app-header').getBoundingClientRect();
        const children = [...document.querySelector('.app-header').children].filter(node => {
          const style = getComputedStyle(node), box = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width && box.height;
        });
        return {overflow: document.documentElement.scrollWidth > innerWidth,
          oneRow: children.every(node => { const box = node.getBoundingClientRect(); return box.top >= header.top && box.bottom <= header.bottom; })};
      });
      assert.deepEqual(layout, {overflow: false, oneRow: true});
      await resize(393, 852);
      await page.getByRole('button', {name: 'Review', exact: true}).click();
      await page.waitForFunction(() => document.querySelector('#profileDialog').open && document.querySelector('[aria-label="Expected and heard notes"]'));
      assert.ok((await page.locator('[aria-label="Expected and heard notes"]').innerText()).includes('Corrected'));
      await page.locator('[data-close="profileDialog"]').click();
      assert.ok(await page.locator('#sheetMusic .score-mark-cross').count() > 0);
      await page.getByRole('button', {name: 'Try again'}).click();
      await page.locator('#readingResultTray').waitFor({state: 'hidden'});
      assert.deepEqual(await page.evaluate(() => window.testReadingStream.progress.target.map(note => note.pitch)), first);
      await page.evaluate(async () => {
        const stream = window.testReadingStream;
        const target = stream.progress.target;
        const notes = stream.progress.attacks.flatMap((attack, i) => attack.indices.map(index => ({pitch: target[index].pitch, start: 1 + i * .4, velocity: 80, confidence: .95})));
        await stream.accept(notes, 0, 100, stream.generation, 100);
      });
      await page.locator('#readingResultTray').waitFor({state: 'visible'});
      assert.ok((await page.locator('#readingResultTray').innerText()).includes('0 XP earned'));
      await page.getByRole('button', {name: 'Next score'}).click();
      await page.locator('#readingResultTray').waitFor({state: 'hidden'});
      await page.evaluate(async () => {
        const stream = window.testReadingStream, progress = stream.progress;
        const pitch = progress.expected[0], start = progress.latest + 1;
        await stream.accept([{pitch: pitch > 106 ? pitch - 2 : pitch + 2, start, velocity: 80, confidence: .95}], 0, start + 1, stream.generation, start + 1);
      });
      assert.ok((await page.locator('#noteStatus').innerText()).includes('expected'));
      await page.locator('#modeMenuButton').click();
      await page.locator('#drillsMode').click();
      await page.waitForFunction(() => document.body.dataset.mode === 'drills' && document.querySelector('#drillTitle').textContent !== 'Drills');
      assert.ok((await page.locator('#drillProgress').innerText()).toLowerCase().includes('drill'));
      assert.ok((await page.locator('#drillBest').innerText()).startsWith('Best tempo'));
      assert.equal(await page.locator('#drillBest').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      assert.equal(await page.locator('#openProfile').isVisible(), false);
      assert.equal(await page.locator('#noteStatus').innerText(), '');
      await page.locator('#modeMenuButton').click();
      await page.locator('#libraryMode').click();
      await page.waitForFunction(() => document.body.dataset.mode === 'library');
      assert.equal(await page.locator('#openProfile').isVisible(), false);
      assert.equal(await page.locator('#drillProgress').isVisible(), false);
      assert.equal(await page.locator('#hudNotes').isVisible(), false);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await rm(profile, {recursive: true, force: true}); }
  });
}
