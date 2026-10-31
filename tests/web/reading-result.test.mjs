import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {after, before, test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
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

async function assertRenderedContrast(page, selector, minimumCount) {
  const rows = await page.locator(selector).evaluate(root => {
    // Match numeric RGB and alpha channels in computed CSS color values.
    const color = value => (value.match(/[\d.]+/g) || []).map(Number);
    const blend = (front, back) => front.slice(0, 3).map((channel, i) => channel * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
    const luminance = rgb => {
      const [r, g, b] = rgb.map(channel => {
        const value = channel / 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      });
      return .2126 * r + .7152 * g + .0722 * b;
    };
    return [root, ...root.querySelectorAll('*')].flatMap(node => {
      if (node.closest('svg') || ![...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())) return [];
      const style = getComputedStyle(node);
      if (!node.getClientRects().length || style.visibility !== 'visible') return [];
      const ancestors = [];
      for (let current = node; current; current = current.parentElement) ancestors.unshift(current);
      let background = [255, 255, 255], opacity = 1;
      for (const ancestor of ancestors) {
        const computed = getComputedStyle(ancestor);
        if (computed.backgroundImage !== 'none') throw new Error(`Cannot audit background image on ${ancestor.tagName}`);
        background = blend(color(computed.backgroundColor), background);
        opacity *= Number(computed.opacity);
      }
      const foreground = color(style.color);
      foreground[3] = (foreground[3] ?? 1) * opacity;
      const values = [luminance(blend(foreground, background)), luminance(background)].sort((a, b) => a - b);
      return [{text: node.textContent.trim(), color: style.color, background, ratio: (values[1] + .05) / (values[0] + .05)}];
    });
  });
  assert.ok(rows.length >= minimumCount, `${selector}: audited only ${rows.length} text elements`);
  assert.deepEqual(rows.filter(row => row.ratio < 4.5), [], `${selector}: insufficient rendered text contrast`);
}

async function auditThemes(page, selector, minimumCount) {
  const previous = await page.evaluate(() => ({theme: document.documentElement.dataset.theme, night: document.documentElement.dataset.night}));
  for (const [theme, night] of [['light', 'false'], ['dark', 'false'], ['dark', 'true']]) {
    await page.evaluate(({theme, night}) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.night = night; }, {theme, night});
    await page.waitForTimeout(200);
    await assertRenderedContrast(page, selector, minimumCount);
  }
  await page.evaluate(previous => { document.documentElement.dataset.theme = previous.theme; document.documentElement.dataset.night = previous.night; }, previous);
}

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
        for (const selector of ['.progress-ring-fill', '.progress-result-fill', '.progress-beam']) {
          assert.equal(await page.locator(selector).first().evaluate(node => getComputedStyle(node).animationName), 'none');
        }
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
      const statusAfter = page.locator('#noteStatus');
      assert.equal((await statusAfter.boundingBox()).height, 18);
      assert.ok((await statusAfter.innerText()).includes('expected'));
      assert.ok((await statusAfter.innerText()).includes('heard'));
      const resultText = await page.locator('#readingResultTray').innerText();
      assert.ok(resultText.includes('expected') && resultText.includes('heard'));
      await auditThemes(page, '#readingResultTray', 6);
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
      await page.locator('#sheetMusic .score-system svg .vf-stavenote').first().waitFor();
      await page.evaluate(async path => {
        const {DrillPicker} = await import(path);
        const picker = new DrillPicker();
        const task = {key: 'C', drill: {practice: 'normal'}, target: [{pitch: 60}, {pitch: 62}, {pitch: 64}]};
        const timeline = [
          {index: 0, bar: 1, tempo: 60, deviation_ms: 0, velocity: 70, flag: null, missed: false},
          {index: 1, bar: 1, tempo: 62, deviation_ms: 60, velocity: 100, flag: 'late', missed: false},
          {index: 2, bar: 2, tempo: 65, deviation_ms: null, velocity: null, flag: null, missed: true},
        ];
        const drill = {clean: false, usable: true, issues: ['Missed a note'], pitch: 75, evenness: 80,
          drift_percent: 12, played_bpm: 62, loudness: 70, sync_ms: 20, accents: 60, crossing_ms: 50,
          targets: {pitch: 90, evenness: 85, drift: 5}, timing_ms: 50, timeline};
        window.testDrillResult = {picker, task, assessment: {drill, score: {missing: 1, extra: 0}, feedback: 'Keep a steady tempo'}};
        picker.renderResults(task, window.testDrillResult.assessment, () => { window.reviewedDrill = true; }, 'Best tempo 60');
      }, `/@fs${resolve('src/piano_duet/static/drills.mjs')}`);
      assert.ok(await page.locator('#drillResults').isVisible());
      assert.equal(await page.locator('.drill-meter').count(), 7);
      await auditThemes(page, '#drillResults', 25);
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'light';
        document.querySelector('#drillResults').style.backgroundColor = '#161d27';
      });
      await page.waitForTimeout(200);
      // Match the contrast audit's failure for the original dark panel.
      await assert.rejects(assertRenderedContrast(page, '#drillResults', 25), /insufficient rendered text contrast/);
      await page.evaluate(({theme, night}) => {
        document.querySelector('#drillResults').style.removeProperty('background-color');
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.night = String(night);
      }, {theme, night});
      await page.waitForTimeout(200);
      if (process.env.PROGRESS_SCREENSHOTS) {
        await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-portrait-drill-result.png`});
        await resize(1440, 900);
        await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-desktop-drill-result.png`});
        await resize(393, 852);
      }
      await page.getByRole('button', {name: 'Review notes'}).click();
      assert.equal(await page.evaluate(() => window.reviewedDrill), true);
      await page.evaluate(() => {
        const {picker, task, assessment} = window.testDrillResult;
        assessment.drill.clean = true;
        picker.renderResults(task, assessment, () => {});
      });
      await auditThemes(page, '#drillResults', 24);
      await page.evaluate(() => window.testDrillResult.picker.renderSummary('Session complete', ['A steady rep'], () => {}));
      await auditThemes(page, '#drillResults', 4);
      await page.locator('#drillResults').evaluate(node => { node.hidden = true; });
      if (process.env.PROGRESS_SCREENSHOTS) await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-portrait-drills.png`});
      await page.waitForFunction(() => !document.querySelector('#start').disabled);
      await page.locator('#start').click();
      await page.waitForFunction(() => document.querySelector('#start').getAttribute('aria-pressed') === 'true');
      assert.equal(await page.locator('#drillProgress').isVisible(), false);
      assert.equal(await page.locator('#drillBest').isVisible(), false);
      if (process.env.PROGRESS_SCREENSHOTS) await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-portrait-drills-playing.png`});
      await page.locator('#start').click();
      await page.waitForFunction(() => document.querySelector('#start').getAttribute('aria-pressed') === 'false');
      assert.equal(await page.locator('#drillProgress').isVisible(), true);
      assert.equal(await page.locator('#drillBest').isVisible(), true);
      await page.locator('#modeMenuButton').click();
      await page.locator('#libraryMode').click();
      await page.waitForFunction(() => document.body.dataset.mode === 'library' && document.querySelector('#songEmpty').textContent.length > 0);
      const measures = Array.from({length: 4}, (_, index) => `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' : ''}<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>`).join('');
      const score = `<score-partwise><work><work-title>Practice song</work-title></work><part id="P1">${measures}</part></score-partwise>`;
      await page.locator('#libraryFile').setInputFiles({name: 'practice.musicxml', mimeType: 'application/xml', buffer: Buffer.from(score)});
      await page.getByText('Practice song', {exact: true}).waitFor();
      if (process.env.PROGRESS_SCREENSHOTS) await page.screenshot({path: `${process.env.PROGRESS_SCREENSHOTS}/${captureName}-portrait-library.png`});
      assert.equal(await page.locator('#openProfile').isVisible(), false);
      assert.equal(await page.locator('#drillProgress').isVisible(), false);
      assert.equal(await page.locator('#hudNotes').isVisible(), false);
      await page.getByText('Practice song', {exact: true}).click();
      await page.waitForFunction(() => document.body.classList.contains('song-open'));
      assert.equal(await page.locator('#songAccuracy').evaluate(node => getComputedStyle(node).display), 'none');
      assert.equal(await page.locator('#songStreak').evaluate(node => getComputedStyle(node).display), 'none');
      await page.evaluate(() => {
        document.body.dataset.mode = 'practice';
        document.querySelector('#practicePanel').hidden = false;
        document.querySelector('#practiceScore').textContent = '85%';
        document.querySelector('#practiceFeedback').textContent = 'Keep going';
        document.querySelector('#drillMetrics').textContent = 'Notes 85%';
        document.querySelector('#drillMetrics').hidden = false;
        document.querySelector('#practiceResult').hidden = false;
      });
      await auditThemes(page, '#practiceResult', 4);
      await page.evaluate(() => {
        document.body.dataset.mode = 'learning';
        document.querySelector('#learningPanel').hidden = false;
        document.querySelector('#learningScore').textContent = '85 / 100';
        document.querySelector('#learningFeedback').textContent = 'A good start';
        document.querySelector('#learningResult').hidden = false;
      });
      await auditThemes(page, '#learningResult', 2);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await rm(profile, {recursive: true, force: true}); }
  });
}
