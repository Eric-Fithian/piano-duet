import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {after, before, test} from 'node:test';
import {chromium, webkit} from 'playwright';
import {MIN_FIT_SCALE} from '../../src/piano_duet/static/score_view.mjs';
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
      let releaseFont, releaseLater;
      const fontGate = new Promise(resolve => { releaseFont = resolve; });
      const laterGate = new Promise(resolve => { releaseLater = resolve; });
      await page.route('**/score-font-*.woff2', async route => {
        await (route.request().url().endsWith('score-font-later.woff2') ? laterGate : fontGate);
        await route.fulfill({body: font, contentType: 'font/woff2'});
      });
      await page.waitForFunction(() => !window.scoreFixture.view.timer && document.fonts.status === 'loaded');
      await page.waitForTimeout(150);
      await page.waitForFunction(() => !window.scoreFixture.view.timer && document.fonts.status === 'loaded');
      const previous = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
      await page.evaluate(() => {
        const face = new FontFace('Score delayed font', 'url(/score-font-delay.woff2)');
        document.fonts.add(face);
        window.delayedFont = face.load();
      });
      await page.waitForFunction(() => document.fonts.status === 'loading');
      await page.evaluate(() => window.scoreFixture.view.schedule(window.scoreFixture.phrase));
      await page.waitForTimeout(150);
      assert.equal(await previous.evaluate(element => element.isConnected), true);
      releaseFont();
      await page.waitForFunction(element => !element.isConnected, previous, {timeout: 10000});
      await page.evaluate(() => window.delayedFont);
      await page.waitForFunction(() => !window.scoreFixture.view.timer, null, {timeout: 10000});
      // WebKit does not reliably dispatch FontFaceSet events for programmatic font loads.
      if (name === 'chromium') {
        const beforeFontChange = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
        await page.evaluate(() => {
          const face = new FontFace('Score later font', 'url(/score-font-later.woff2)');
          document.fonts.add(face);
          window.laterFont = document.fonts.load('16px "Score later font"');
        });
        await page.waitForFunction(() => document.fonts.status === 'loading');
        releaseLater();
        await page.evaluate(() => window.laterFont);
        await page.waitForFunction(element => !element.isConnected, beforeFontChange, {timeout: 10000});
      }
      await page.evaluate(() => {
        const {view, phrase} = window.scoreFixture;
        const notes = Array.from({length: 16}, (_, index) => ({pitch: 60 + index % 5, start: index, duration: 1, staff: 'treble'}));
        view.update(phrase, {notes});
      });
      await page.waitForFunction(() => !window.scoreFixture.view.timer && window.scoreFixture.phrase.marks.filter(mark => mark.ids.length).length === 16);
      for (const [width, height] of [[1440, 900], [393, 852], [852, 393], [820, 1180]]) {
        const previousSystem = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
        await page.setViewportSize({width, height});
        if (width !== 1440) await page.waitForFunction(element => !element.isConnected, previousSystem, {timeout: 10000});
        const gaps = await page.evaluate(() => window.scoreFixture.phrase.systems.flatMap(system => {
          const marks = system.marks.filter(mark => mark.ids.length).sort((a, b) => a.start - b.start);
          return marks.slice(1).map((mark, index) => {
            const before = marks[index].note.noteHeads[0];
            const after = mark.note.noteHeads[0];
            return (after.getAbsoluteX() - before.getAbsoluteX() - before.getWidth()) / 10;
          });
        }));
        assert.ok(gaps.length && Math.min(...gaps) >= 0.5, `${width}: adjacent notehead gaps in staff spaces: ${gaps.join(', ')}`);
        if (width === 393) assert.ok(await page.evaluate(() => window.scoreFixture.phrase.systems.length > 1));
        if (width === 1440) assert.equal(await page.evaluate(() => window.scoreFixture.phrase.systems.length), 1);
      }

      await page.waitForFunction(() => !window.scoreFixture.view.timer);
      const playingSystem = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
      const pinnedScale = await page.evaluate(() => {
        const {view} = window.scoreFixture;
        view.setActive(true);
        return view.fittedScale;
      });
      await page.setViewportSize({width: 820, height: 900});
      await page.evaluate(() => window.scoreFixture.view.relayout());
      await page.waitForTimeout(250);
      assert.equal(await playingSystem.evaluate(element => element.isConnected), true);
      assert.equal(await page.evaluate(() => window.scoreFixture.view.fittedScale), pinnedScale);
      await page.setViewportSize({width: 900, height: 900});
      await page.waitForFunction(element => !element.isConnected, playingSystem, {timeout: 10000});
      assert.equal(await page.evaluate(() => window.scoreFixture.view.fittedScale), pinnedScale);
      const resizedSystem = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
      await page.evaluate(() => window.scoreFixture.view.setActive(false));
      await page.waitForFunction(element => !element.isConnected, resizedSystem, {timeout: 10000});

      const beforeHeight = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
      await page.evaluate(() => {
        const {view} = window.scoreFixture;
        document.querySelector('#scoreFixture').style.bottom = '100px';
        view.relayout();
        view.setActive(true);
      });
      await page.waitForTimeout(250);
      assert.equal(await beforeHeight.evaluate(element => element.isConnected), true);
      await page.evaluate(() => window.scoreFixture.view.setActive(false));
      await page.waitForFunction(element => !element.isConnected, beforeHeight, {timeout: 10000});

      // WebKit does not reliably deliver synthetic FontFaceSet loading events.
      if (name === 'chromium') {
        const beforeActiveFont = await page.locator('#scoreFixture .score-system svg').first().elementHandle();
        await page.evaluate(() => {
          window.scoreFixture.view.setActive(true);
          document.fonts.dispatchEvent(new Event('loading'));
        });
        await page.waitForTimeout(250);
        assert.equal(await beforeActiveFont.evaluate(element => element.isConnected), true);
        await page.evaluate(() => window.scoreFixture.view.setActive(false));
        await page.waitForFunction(element => !element.isConnected, beforeActiveFont, {timeout: 10000});
      }

      await page.setViewportSize({width: 360, height: 800});
      await page.evaluate(() => {
        const {view} = window.scoreFixture;
        document.querySelector('#scoreFixture').style.bottom = '0';
        view.use('fixture-library', {scale: 1.05, cursor: true, feedback: true});
        const notes = Array.from({length: 16}, (_, index) => ({pitch: 60 + index % 5, start: index / 4, duration: .25, staff: 'treble'}));
        window.scoreFixture.phrase = view.add('target', notes, {bpm: 60, meter: '4/4', clef: 'grand', bars: 1, exact: true});
      });
      await page.waitForFunction(() => !window.scoreFixture.view.timer && window.scoreFixture.phrase.systems?.length);
      const dense = await page.evaluate(() => {
        const {view, phrase} = window.scoreFixture;
        const system = phrase.systems[0], available = view.scroller.clientWidth - 24;
        return {available, natural: system.frame.width * view.scale, drawn: system.svg.getBoundingClientRect().width, scale: system.scale};
      });
      assert.ok(dense.natural > dense.available, JSON.stringify(dense));
      assert.ok(dense.drawn <= dense.available + 1 && dense.scale < MIN_FIT_SCALE, JSON.stringify(dense));

      await page.evaluate(() => {
        const {view} = window.scoreFixture;
        view.use('fixture-editor', {scale: 1.05, stableFit: true});
        const notes = [0, 4, 8, 12].map((start, index) => ({pitch: 60 + index, start, duration: 1, staff: 'treble'}));
        window.scoreFixture.phrase = view.add('target', notes, {bpm: 60, meter: '4/4', clef: 'treble', bars: 4, exact: true});
      });
      await page.waitForFunction(() => !window.scoreFixture.view.timer && window.scoreFixture.phrase.systems?.length);
      const editorScale = await page.evaluate(() => {
        const {view, phrase} = window.scoreFixture;
        window.editorReplacements = 0;
        window.editorObserver = new MutationObserver(records => { window.editorReplacements += records.filter(record => record.removedNodes.length).length; });
        window.editorObserver.observe(phrase.host, {childList: true});
        view.update(phrase, {notes: phrase.notes.map((note, index) => index ? note : {...note, pitch: note.pitch + 2})});
        return view.fittedScale;
      });
      await page.waitForFunction(() => !window.scoreFixture.view.timer);
      const edit = await page.evaluate(() => ({scale: window.scoreFixture.view.fittedScale, replacements: window.editorReplacements}));
      assert.equal(edit.scale, editorScale);
      assert.equal(edit.replacements, 1);
      const switched = await page.evaluate(() => {
        const {view} = window.scoreFixture;
        view.fittedScale = 3.8;
        view.use('fixture-switch', {scale: 1});
        const fitted = view.fittedScale;
        view.step(1);
        return {fitted, zoom: view.preferences.zoom};
      });
      assert.deepEqual(switched, {fitted: null, zoom: 1.5});
      await page.evaluate(() => {
        const {view} = window.scoreFixture;
        view.fittedScale = 3.8;
        view.use('fixture-header', {scale: 1});
        view.set({layout: 'line'});
        window.scoreFixture.phrase = view.add('target', [{pitch: 60, start: 0, duration: 1, staff: 'treble'}],
          {bpm: 60, meter: '4/4', clef: 'treble', bars: 1, exact: true});
      });
      await page.waitForFunction(() => !window.scoreFixture.view.timer && window.scoreFixture.phrase.engraved?.header);
      const headerScale = await page.evaluate(() => {
        const header = window.scoreFixture.phrase.engraved.header;
        return parseFloat(header.svg.style.width) / header.frame.width;
      });
      assert.ok(Math.abs(headerScale - MIN_FIT_SCALE) < 0.001);
    } finally {
      await context.close();
      await rm(profile, {recursive: true, force: true});
    }
  });
}
