import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {startTestServer} from './server.mjs';

const sizes = [['se', 375, 667], ['iphone', 393, 852], ['promax', 430, 932],
  ['android', 360, 800], ['mini', 744, 1133], ['desktop', 1440, 900]];
const bytes = Buffer.alloc(1644);
bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
const sample = {pitch: 60, file: 'C4.mp3', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
let server, port;
before(async () => { ({server, port} = await startTestServer()); }, {timeout: 45000});
after(() => server?.kill('SIGTERM'));

async function checkLayout(page, label) {
  const issues = await page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth) problems.push(`page width ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const element of document.querySelectorAll('body *')) {
      if (element.closest('#sheetMusic') || element.matches('input, textarea, select')) continue;
      const style = getComputedStyle(element);
      if (['auto', 'scroll'].includes(style.overflowX) && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1) {
        problems.push(`horizontal scroll: ${element.id || element.className}`);
      }
    }
    const modal = document.querySelector('dialog[open]');
    const scope = modal || document;
    const elements = [...scope.querySelectorAll('button, select, input:not([type=hidden]), a[href], summary')].filter(element => {
      const closed = element.closest('details:not([open])');
      if (closed && !element.closest('summary')) return false;
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !rect.width || !rect.height) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (['auto', 'scroll', 'hidden', 'clip'].includes(parentStyle.overflowY) && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) return false;
        if (['auto', 'scroll', 'hidden', 'clip'].includes(parentStyle.overflowX) && (rect.right <= bounds.left || rect.left >= bounds.right)) return false;
      }
      return true;
    });
    for (const [index, element] of elements.entries()) {
      const rect = element.getBoundingClientRect(), name = element.id || element.textContent.trim().slice(0, 30);
      if (rect.left < -1 || rect.right > innerWidth + 1) problems.push(`outside viewport horizontally: ${name}`);
      if (rect.top < -1 || rect.bottom > innerHeight + 1) {
        let scrollable = false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) scrollable = true;
        }
        if (!scrollable) problems.push(`outside viewport vertically: ${name}`);
      }
      for (const other of elements.slice(index + 1)) {
        if (element.contains(other) || other.contains(element)) continue;
        const b = other.getBoundingClientRect();
        if (Math.min(rect.right, b.right) - Math.max(rect.left, b.left) > 1 && Math.min(rect.bottom, b.bottom) - Math.max(rect.top, b.top) > 1) {
          problems.push(`overlap: ${name} / ${other.id || other.textContent.trim().slice(0, 30)}`);
        }
      }
    }
    return problems;
  });
  assert.deepEqual(issues, [], `${label}: ${issues.join('; ')}`);
}

for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${engineName} keeps modes and dialogs usable across viewport sizes`, {timeout: 240000}, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'piano-responsive-'));
    const context = await engine.launchPersistentContext(profile, {headless: true, viewport: {width: 375, height: 667}, hasTouch: true});
    try {
    await context.route('**/src/piano-samples.ts', route => route.fulfill({contentType: 'text/javascript', body: `export const SAMPLE_REVISION = "responsive-fixture"; export const PIANO_SAMPLES = ${JSON.stringify([sample])};`}));
    await context.route('https://raw.githubusercontent.com/**/responsive-fixture/samples/piano/C4.mp3', route => route.fulfill({body: bytes, headers: {'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'}}));
    await context.route('**/src/browser-inference.ts', route => route.fulfill({contentType: 'text/javascript', body: 'export class BrowserInference { async createSession(model) { return {model, provider: "wasm", run: async () => model === "aria" ? {logits: new Float32Array(18000)} : {notes: []}}; } }'}));
    await context.route('**/src/browser-recording-import.ts', route => route.fulfill({contentType: 'text/javascript', body: 'export class BrowserRecordingImporter { async prepare() {} }'}));
    await context.route('**/sync-config.json', route => route.fulfill({json: {url: 'http://127.0.0.1:54321', anonKey: 'fixture', emailEnabled: false, providers: ['google']}}));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {configurable: true, value: async () => {
        const audio = new AudioContext();
        await audio.resume();
        const destination = audio.createMediaStreamDestination();
        window.responsiveMicrophone = {audio, destination};
        return destination.stream;
      }});
      Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'enumerateDevices', {configurable: true, value: async () => []});
    });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('#sheetMusic .score-system svg').first().waitFor({timeout: 30000});
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'reading');
    for (const mode of ['practice', 'duet', 'learning']) assert.equal(await page.locator(`#${mode}Mode`).isHidden(), true);
    assert.equal(await page.locator('.key-cap').isVisible(), false);
    async function settledScore() {
      await page.waitForFunction(() => {
        const scroller = document.querySelector('.score-scroller');
        const system = document.querySelector('.score-system svg');
        return system && Math.abs(system.getBoundingClientRect().width - scroller.clientWidth) < 40;
      }, null, {timeout: 10000});
    }
    const portraitSystems = await page.locator('.score-phrase').first().locator('.score-system').count();
    assert.equal(portraitSystems, 2);
    await page.locator('#hudListen').click();
    await page.waitForFunction(() => document.querySelector('#hudListen').classList.contains('playing'));
    await page.setViewportSize({width: 667, height: 375});
    await page.waitForFunction(count => document.querySelector('.score-phrase').querySelectorAll('.score-system').length < count, portraitSystems, {timeout: 5000});
    assert.equal(await page.locator('#hudListen').evaluate(button => button.classList.contains('playing')), true);
    assert.equal(await page.locator('.reading-cursor').count() > 0, true);
    await page.setViewportSize({width: 375, height: 667});
    await page.waitForFunction(count => document.querySelector('.score-phrase').querySelectorAll('.score-system').length === count, portraitSystems, {timeout: 5000});
    assert.equal(await page.locator('#hudListen').evaluate(button => button.classList.contains('playing')), true);
    await page.locator('#hudListen').click();
    await page.locator('#start').waitFor({state: 'visible'});
    await page.waitForFunction(() => !document.querySelector('#start').disabled);
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#start').getAttribute('aria-pressed') === 'true', null, {timeout: 10000});
    await page.setViewportSize({width: 667, height: 375});
    await page.waitForFunction(count => document.querySelector('.score-phrase').querySelectorAll('.score-system').length < count, portraitSystems, {timeout: 5000});
    assert.equal(await page.locator('#start').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.reading-cursor').count() > 0, true);
    await page.setViewportSize({width: 375, height: 667});
    await page.waitForFunction(count => document.querySelector('.score-phrase').querySelectorAll('.score-system').length === count, portraitSystems, {timeout: 5000});
    assert.equal(await page.locator('#start').getAttribute('aria-pressed'), 'true');
    await page.locator('#start').click();
    async function capture(name) {
      await checkLayout(page, `${engineName} ${name}`);
      if (process.env.RESPONSIVE_SCREENSHOTS) {
        await mkdir(process.env.RESPONSIVE_SCREENSHOTS, {recursive: true});
        await page.screenshot({path: `${process.env.RESPONSIVE_SCREENSHOTS}/${engineName}-${name}.png`});
      }
    }
    async function mode(name) {
      if (await page.locator('#modeMenuButton').isVisible()) await page.locator('#modeMenuButton').click();
      await page.locator(`#${name}Mode`).click();
      await page.waitForFunction(value => document.body.dataset.mode === value, name);
      if (name !== 'library') await page.locator('#sheetMusic .score-system svg').first().waitFor({timeout: 30000});
    }
    async function resizeScore(width, height) {
      const before = page.viewportSize();
      const system = await page.locator('.score-system svg').first().elementHandle();
      await page.setViewportSize({width, height});
      if (before.width !== width) await page.waitForFunction(element => !element.isConnected, system, {timeout: 10000});
      await settledScore();
    }
    const viewports = sizes.flatMap(([device, w, h]) => [['portrait', w, h], ['landscape', h, w]].map(([orientation, width, height]) => ({name: `${device}-${orientation}`, width, height})));
    await mode('reading');
    for (const {name, width, height} of viewports) {
      await resizeScore(width, height); await capture(`${name}-reading`);
    }
    await mode('drills');
    for (const {name, width, height} of viewports) {
      await resizeScore(width, height); await capture(`${name}-drills`);
      if (await page.locator('#drillMore').isVisible()) {
        await page.locator('#drillMore').click();
        await checkLayout(page, `${engineName} ${name}-drill-more`);
        const score = await page.locator('#sheetMusic').boundingBox();
        await page.mouse.click(score.x + 5, score.y + score.height - 5);
        assert.equal(await page.locator('#drillMore').getAttribute('aria-expanded'), 'false');
        await page.locator('#drillMore').click();
        await page.locator('.score-scroller').evaluate(element => element.dispatchEvent(new Event('scroll')));
        assert.equal(await page.locator('#drillMore').getAttribute('aria-expanded'), 'false');
        await page.locator('#drillMore').click();
      }
      await page.locator('#drillSession').click(); await capture(`${name}-session`);
      await page.locator('[data-close="sessionDialog"]').click();
    }
    await mode('library');
    for (const {name, width, height} of viewports) {
      await page.setViewportSize({width, height}); await capture(`${name}-library`);
      await page.locator('#importAudio').click(); await capture(`${name}-recording`);
      await page.locator('#recordingClose').click();
      await page.locator('#openSettings').click(); await capture(`${name}-settings`);
      await page.locator('#accountSync').scrollIntoViewIfNeeded();
      assert.equal(await page.getByRole('button', {name: 'Continue with Google'}).isVisible(), true);
      assert.equal(await page.locator('#syncSignIn').isVisible(), false);
      await capture(`${name}-sign-in`);
      await page.locator('[data-close="settingsDialog"]').click();
    }
    await page.setViewportSize({width: 375, height: 667});
    const measures = Array.from({length: 8}, (_, index) => `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' : ''}<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>`).join('');
    const score = `<score-partwise><work><work-title>Viewport song</work-title></work><part id="P1">${measures}</part></score-partwise>`;
    await page.locator('#libraryFile').setInputFiles({name: 'viewport.musicxml', mimeType: 'application/xml', buffer: Buffer.from(score)});
    await page.getByText('Viewport song', {exact: true}).click();
    await page.locator('#sheetMusic .score-system svg').first().waitFor({timeout: 30000});
    await page.locator('#songSectionSelect').selectOption('1');
    for (const {name, width, height} of viewports) {
      await resizeScore(width, height);
      assert.equal(await page.locator('#songSectionSelect').inputValue(), '1');
      await capture(`${name}-song`);
    }
    await page.setViewportSize({width: 375, height: 667});
    await page.locator('#songEdit').click();
    await page.locator('#sheetMusic .score-system svg').first().waitFor({timeout: 30000});
    await capture('se-portrait-song-editor');
    await page.locator('#editMore').click();
    await checkLayout(page, `${engineName} editor settings`);
    await page.locator('#editOptions').evaluate(element => element.dispatchEvent(new Event('scroll')));
    assert.equal(await page.locator('#editMore').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#editMore').getAttribute('aria-expanded'), 'false');
    await resizeScore(667, 375);
    await capture('se-landscape-song-editor');
    await page.locator('#editCancel').click();
    await page.locator('#songBack').click();
    await mode('reading');
    await page.evaluate(async path => {
      const {localRequest} = await import(`${path}/practice.mjs`);
      const task = await localRequest('/api/practice/next', {focus: 'reading', step_by_step: true});
      const groups = task.target.map((note, index) => [{pitch: note.pitch, start: 1 + index, velocity: 80, confidence: 0.95}]);
      await localRequest('/api/reading/complete', {task: task.id, attempt: crypto.randomUUID(), groups, interruptions: [], threshold: 0.8});
      const app = await import(`${path}/app.mjs`);
      await app.refreshProfile();
    }, `/@fs${resolve('src/piano_duet/static')}`);
    await page.locator('#openProfile').click();
    await page.locator('#readingHistory .recent-score').first().click();
    await page.locator('#attemptDetail').waitFor({state: 'visible'});
    assert.equal(await page.locator('#profileTitle').textContent(), 'Your score');
    assert.equal(await page.locator('#skillCards').isVisible(), false);
    await page.locator('[data-close="profileDialog"]').click();
    await page.evaluate(async path => {
      const {writeLearnerSetting} = await import(path);
      await writeLearnerSetting('piano-duet.mode', 'duet');
    }, `/@fs${resolve('src/piano_duet/static/learner-settings.mjs')}`);
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.mode === 'reading', null, {timeout: 30000});
    assert.equal(await page.locator('#duetMode').isHidden(), true);
    await page.locator('#sheetMusic .score-system svg').first().waitFor({timeout: 30000});
    assert.equal(await page.locator('#error').isHidden(), true);
    assert.deepEqual(errors, []);
    } finally { await context.close(); await rm(profile, {recursive: true, force: true}); }
  });
}
