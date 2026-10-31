import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium, webkit} from 'playwright';
import {startTestServer} from '../../tests/web/server.mjs';

const qaDir = '/private/tmp/piano-rebrand/site';
const docDir = 'site/src/assets/screenshots';
const qaOnly = process.argv.includes('--qa-only');
const sampleUrl = 'https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/622c2f1c32c8cfce4158ddc3eb26e518ddef37e5/samples/piano/C4.mp3';
const sampleSha = 'a265c8cfd4140cf27b55054b4953b6c691fce3523530ca8ae0faed5e4cd39063';
const pitches = [0, 2, 4, 5, 7, 5, 4, 2, 0];
const sizes = [['desktop', 1440, 900], ['portrait', 393, 852], ['landscape', 852, 393], ['tablet', 768, 1024]];
const scratch = await mkdtemp(join(tmpdir(), 'piano-product-capture-'));
let server;
try {
  execFileSync('npm', ['run', 'build', '--prefix', 'site'], {stdio: 'inherit'});
  const response = await fetch(sampleUrl);
  assert.ok(response.ok, `Piano sample download failed: ${response.status}`);
  const sample = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(sample).digest('hex'), sampleSha);
  const mp3 = join(scratch, 'c4.mp3'), wav = join(scratch, 'drill.wav');
  await writeFile(mp3, sample);
  const ffmpeg = execFileSync('uv', ['run', '--frozen', 'python', '-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], {encoding: 'utf8'}).trim();
  const notes = pitches.map((pitch, i) => `[0:a]aresample=16000,asetrate=${Math.round(16000 * 2 ** (pitch / 12))},aresample=16000,atrim=duration=0.32,volume=0.6,adelay=${3000 + i * 500}:all=1[n${i}]`);
  const mix = `${notes.join(';')};${pitches.map((_, i) => `[n${i}]`).join('')}amix=inputs=${pitches.length}:duration=longest:normalize=0,apad=pad_dur=60[out]`;
  execFileSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', mp3, '-filter_complex', mix, '-map', '[out]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {stdio: 'inherit'});
  await mkdir(qaDir, {recursive: true});
  const preview = await startTestServer(true);
  server = preview.server;
  const base = `http://127.0.0.1:${preview.port}`;
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const args = engineName === 'chromium' ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] : [];
    for (const theme of ['light', 'dark', 'night']) {
      console.log(`Capturing ${engineName} ${theme} production views`);
      const context = await engine.launchPersistentContext(join(scratch, `${engineName}-${theme}`), {headless: true, args, viewport: {width: 1440, height: 900}, colorScheme: theme === 'light' ? 'light' : 'dark', permissions: engineName === 'chromium' ? ['microphone'] : []});
      if (engineName === 'webkit') {
        await context.addInitScript(({audio, offsets}) => {
          Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {configurable: true, value: async () => {
            const context = new AudioContext({sampleRate: 16000});
            await context.resume();
            const bytes = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
            const sample = await context.decodeAudioData(bytes.buffer);
            const output = context.createMediaStreamDestination();
            for (const [i, pitch] of offsets.entries()) {
              const source = context.createBufferSource();
              const gain = context.createGain();
              source.buffer = sample;
              source.playbackRate.value = 2 ** (pitch / 12);
              gain.gain.value = 0.6;
              source.connect(gain).connect(output);
              const start = context.currentTime + 3 + i * 0.5;
              source.start(start);
              source.stop(start + 0.32);
            }
            return output.stream;
          }});
        }, {audio: sample.toString('base64'), offsets: pitches});
      }
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/`, {waitUntil: 'domcontentloaded'});
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#sheetMusic svg').first().waitFor({timeout: 60000});
      await page.locator('#openSettings').click();
      await page.locator('#appearanceTheme').selectOption(theme === 'light' ? 'light' : 'dark');
      await page.locator('#nightPage').setChecked(theme === 'night');
      await page.screenshot({path: `${qaDir}/${engineName}-${theme}-settings.png`});
      await page.locator('[data-close="settingsDialog"]').click();
      for (const [size, width, height] of sizes) {
        await page.setViewportSize({width, height});
        await page.waitForFunction(() => {
          const scroller = document.querySelector('.score-scroller');
          const score = document.querySelector('#sheetMusic svg');
          return scroller && score && Math.abs(score.getBoundingClientRect().width - scroller.clientWidth) < 40;
        }, null, {timeout: 15000});
        await page.screenshot({path: `${qaDir}/${engineName}-${theme}-reading-${size}.png`});
        if (engineName === 'chromium' && theme === 'light' && size === 'desktop') await page.screenshot({path: join(scratch, 'reading.png')});
        if (size === 'portrait') {
          await page.getByRole('button', {name: 'Score controls'}).click();
          await page.screenshot({path: `${qaDir}/${engineName}-${theme}-score-controls.png`});
          await page.getByRole('button', {name: 'Score controls'}).click();
          await page.locator('#modeMenuButton').click();
          await page.screenshot({path: `${qaDir}/${engineName}-${theme}-mode-menu.png`});
          await page.locator('#modeMenuButton').click();
        }
      }
      await page.setViewportSize({width: 1440, height: 900});
      await page.locator('#modeMenuButton').click();
      await page.locator('#drillsMode').click();
      await page.locator('#drillTitle').getByText('five-finger pattern', {exact: false}).waitFor({timeout: 30000});
      await page.screenshot({path: `${qaDir}/${engineName}-${theme}-drills.png`});
      if (engineName === 'chromium' && theme === 'light') await page.screenshot({path: join(scratch, 'drills.png')});
      await page.setViewportSize({width: 393, height: 852});
      await page.waitForFunction(() => {
        const scroller = document.querySelector('.score-scroller');
        const score = document.querySelector('#sheetMusic svg');
        return scroller && score && Math.abs(score.getBoundingClientRect().width - scroller.clientWidth) < 40;
      }, null, {timeout: 15000});
      await page.screenshot({path: `${qaDir}/${engineName}-${theme}-drills-portrait.png`});
      await page.setViewportSize({width: 1440, height: 900});
      if (theme === 'light') {
        console.log(`Capturing a ${engineName} drill take with the simulated microphone`);
        await page.locator('#start').click({timeout: 60000});
        await page.waitForFunction(() => document.querySelector('#start').getAttribute('aria-pressed') === 'true');
        await page.screenshot({path: `${qaDir}/${engineName}-${theme}-drills-playing.png`});
        await page.locator('#drillResults').waitFor({state: 'visible', timeout: 180000});
        await page.screenshot({path: `${qaDir}/${engineName}-${theme}-drill-results.png`});
        if (engineName === 'chromium') await page.screenshot({path: join(scratch, 'drill-results.png')});
        await page.locator('#start').click();
        for (const resultTheme of ['dark', 'night']) {
          await page.locator('#openSettings').click();
          await page.locator('#appearanceTheme').selectOption('dark');
          await page.locator('#nightPage').setChecked(resultTheme === 'night');
          await page.locator('[data-close="settingsDialog"]').click();
          await page.locator('#drillResults').waitFor({state: 'visible'});
          await page.screenshot({path: `${qaDir}/${engineName}-${resultTheme}-drill-results.png`});
        }
        await page.locator('#openSettings').click();
        await page.locator('#appearanceTheme').selectOption('light');
        await page.locator('#nightPage').setChecked(false);
        await page.locator('[data-close="settingsDialog"]').click();
      }
      await page.locator('#modeMenuButton').click();
      await page.locator('#libraryMode').click();
      await page.screenshot({path: `${qaDir}/${engineName}-${theme}-library.png`});
      await page.setViewportSize({width: 393, height: 852});
      await page.screenshot({path: `${qaDir}/${engineName}-${theme}-library-portrait.png`});
      assert.deepEqual(errors, [], `${engineName} ${theme} page errors`);
      await context.close();
    }
  }
  if (!qaOnly) for (const name of ['reading.png', 'drills.png', 'drill-results.png']) await copyFile(join(scratch, name), join(docDir, name));
  console.log(`Production captures: ${qaDir}${qaOnly ? '' : `; documentation images: ${docDir}`}`);
} finally {
  server?.kill('SIGTERM');
  await rm(scratch, {recursive: true, force: true});
}
