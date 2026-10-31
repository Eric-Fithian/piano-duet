import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {startTestServer} from './server.mjs';

let server, port;
before(async () => { ({server, port} = await startTestServer()); }, {timeout: 45000});
after(() => server?.kill('SIGTERM'));

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${name} keeps sparse scores readable, balanced and marked through resize`, {timeout: 90000}, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'score-rendering-'));
    const context = await engine.launchPersistentContext(profile, {headless: true, viewport: {width: 393, height: 852}});
    try {
      await context.route('**/src/browser-inference.ts', route => route.fulfill({contentType: 'text/javascript', body: 'export class BrowserInference {}'}));
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => window.VexFlow && document.fonts.check('12px Bravura'), null, {timeout: 30000});
      const modulePath = `/@fs/${resolve('src/piano_duet/static/score_view.mjs')}`;
      await page.evaluate(async path => {
        const {ScoreView} = await import(path);
        const host = document.createElement('div');
        host.id = 'scoreFixture';
        Object.assign(host.style, {position: 'fixed', inset: '0', zIndex: '100', background: 'white'});
        document.body.append(host);
        const view = new ScoreView(host);
        view.use('fixture', {cursor: true, feedback: true});
        const notes = [0, 4, 8, 12].map((start, index) => ({pitch: 60 + index, start, duration: 1, staff: 'treble', finger: index + 1}));
        const phrase = view.add('target', notes, {bpm: 60, meter: '4/4', clef: 'treble', bars: 4, exact: true});
        const progress = {displayIndex: 2, index: 2, mistakes: new Set([1]), wrong: [], preview: false, bpm: null};
        view.progress(phrase, progress);
        window.scoreFixture = {view, phrase, progress};
      }, modulePath);
      for (const [width, height, bars] of [[393, 852, [2, 2]], [852, 393, [4]], [820, 1180, [4]], [1440, 900, [4]]]) {
        await page.setViewportSize({width, height});
        await page.waitForFunction(expected => {
          const {view, phrase} = window.scoreFixture;
          return !view.timer && phrase.systems?.map(system => system.bars[1] - system.bars[0]).join(',') === expected.join(',');
        }, bars, {timeout: 10000});
        const result = await page.evaluate(() => {
          const {phrase} = window.scoreFixture;
          const system = phrase.systems[0];
          const svg = system.svg;
          const check = svg.querySelector('.score-mark-check');
          const cross = svg.querySelector('.score-mark-cross');
          const finger = svg.querySelector('.score-finger');
          return {scale: system.scale, checkSize: parseFloat(getComputedStyle(check).fontSize) * system.scale,
            crossSize: parseFloat(getComputedStyle(cross).fontSize) * system.scale,
            fingerSize: parseFloat(getComputedStyle(finger).fontSize) * system.scale,
            ring: Boolean(svg.querySelector('.score-mark-ring')),
            cursorBehind: phrase.systems.some(item => item.svg.firstElementChild.classList.contains('reading-cursor'))};
        });
        assert.ok(result.scale >= 1.4 - 0.001, `${width}: ${JSON.stringify(result)}`);
        assert.ok(result.checkSize >= 10 * result.scale && result.crossSize >= 10 * result.scale);
        assert.ok(result.fingerSize >= 12);
        assert.ok(result.ring && result.cursorBehind);
      }
      const colors = await page.evaluate(() => {
        const host = document.querySelector('#scoreFixture');
        const read = () => ({correct: getComputedStyle(host.querySelector('.score-read-done text')).fill,
          wrong: getComputedStyle(host.querySelector('.score-read-missed text')).fill});
        const day = read();
        host.dataset.night = 'true';
        return {day, night: read()};
      });
      assert.deepEqual(colors, {day: {correct: 'rgb(23, 79, 43)', wrong: 'rgb(168, 62, 31)'},
        night: {correct: 'rgb(157, 213, 176)', wrong: 'rgb(195, 110, 72)'}});
      const font = await readFile('src/piano_duet/static/fonts/atkinson-hyperlegible-next-latin.woff2');
      let releaseFont;
      const fontGate = new Promise(resolve => { releaseFont = resolve; });
      await page.route('**/score-font-*.woff2', async route => {
        await fontGate;
        await route.fulfill({body: font, contentType: 'font/woff2'});
      });
      const previous = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
      await page.evaluate(() => {
        const face = new FontFace('Score delayed font', 'url(/score-font-delay.woff2)');
        document.fonts.add(face);
        window.delayedFont = face.load();
        window.scoreFixture.view.schedule(window.scoreFixture.phrase);
      });
      await page.waitForTimeout(150);
      assert.equal(await previous.evaluate(element => element.isConnected), true);
      releaseFont();
      await page.waitForFunction(element => !element.isConnected, previous, {timeout: 10000});
      await page.evaluate(() => window.delayedFont);
      await page.waitForFunction(() => !window.scoreFixture.view.timer, null, {timeout: 10000});
      const beforeFontChange = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
      await page.evaluate(async () => {
        const face = new FontFace('Score later font', 'url(/score-font-later.woff2)');
        document.fonts.add(face);
        await document.fonts.load('16px "Score later font"');
      });
      await page.waitForFunction(element => !element.isConnected, beforeFontChange, {timeout: 10000});
    } finally {
      await context.close();
      await rm(profile, {recursive: true, force: true});
    }
  });
}
