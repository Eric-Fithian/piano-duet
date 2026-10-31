// Visits every screen, menu and dialog in each engine, size and theme; prints audit problems and saves screenshots.
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium, firefox, webkit} from 'playwright';
import {startTestServer} from '../server.mjs';
import {auditPage} from './audit.mjs';

const out = process.argv[2];
const engines = (process.env.ENGINES || 'chromium,firefox,webkit').split(',');
const sizes = {phone: [390, 844], landscape: [844, 390], desktop: [1440, 900]};
const themes = (process.env.THEMES || 'light,dark,night').split(',');
const base = process.env.BASE_URL;
const {server, port} = base ? {} : await startTestServer();
const url = base || `http://127.0.0.1:${port}/`;
await mkdir(out, {recursive: true});
const report = [];
const launchers = {chromium, firefox, webkit};
for (const engineName of engines) {
  for (const theme of themes) for (const [sizeName, [width, height]] of Object.entries(sizes)) {
    // a saved profile, as in a normal window: private contexts have no persistent storage in Firefox and WebKit
    const profile = await mkdtemp(join(tmpdir(), 'piano-visual-'));
    const context = await launchers[engineName].launchPersistentContext(profile, {viewport: {width, height}, colorScheme: theme === 'light' ? 'light' : 'dark', hasTouch: sizeName !== 'desktop'});
    if (theme === 'night') await context.addInitScript(() => { localStorage.setItem('piano-duet-theme', 'dark'); localStorage.setItem('piano-duet-night-page', 'true'); });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.mode, null, {timeout: 60000}).catch(() => errors.push('app never chose a mode'));
    await page.waitForTimeout(1500);
    const shot = async name => {
      const key = `${engineName}-${theme}-${sizeName}-${name}`;
      const problems = await page.evaluate(auditPage);
      for (const problem of problems) report.push(`${key}: ${problem}`);
      await page.screenshot({path: `${out}/${key}.png`});
    };
    const step = async (name, action) => {
      try { await action(); await page.waitForTimeout(500); await shot(name); }
      catch (error) { report.push(`${engineName}-${theme}-${sizeName}-${name}: STEP FAILED ${error.message.split('\n')[0]}`); }
    };
    const closeDialog = () => page.evaluate(() => document.querySelector('dialog[open]')?.close());
    const mode = async id => { await page.locator('#modeMenuButton').click(); await page.locator(`#${id}Mode`).click(); await page.waitForTimeout(1500); };
    await step('reading', async () => { if (await page.evaluate(() => document.body.dataset.mode) !== 'reading') await mode('reading'); });
    await step('mode-menu', () => page.locator('#modeMenuButton').click());
    await page.locator('#modeMenuButton').click().catch(() => {});
    await step('score-controls', () => page.getByRole('button', {name: 'Score controls', exact: true}).click());
    await page.keyboard.press('Escape');
    await step('profile', () => page.locator('#openProfile').click());
    await closeDialog();
    await step('drills', () => mode('drills'));
    await step('drills-picker', () => page.locator('#drillToggle').click());
    await page.locator('#drillToggle').click().catch(() => {});
    await step('drills-more', () => page.locator('#drillMore').click());
    await page.locator('#drillMore').click().catch(() => {});
    await step('drills-help', () => page.locator('#drillDetails').click());
    await closeDialog();
    await step('library', () => mode('library'));
    await step('library-import', () => page.locator('#importMenu > summary').click());
    await step('youtube', () => page.locator('#openYoutube').click());
    await closeDialog();
    await step('settings', () => page.locator('#openSettings').click());
    await step('settings-models', async () => { await page.locator('#settingsDialog summary', {hasText: 'Models'}).first().click(); await page.locator('#settingsDialog summary', {hasText: 'Models'}).first().scrollIntoViewIfNeeded(); });
    for (const error of errors) report.push(`${engineName}-${theme}-${sizeName}: page error ${error}`);
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
}
server?.kill('SIGTERM');
console.log(report.join('\n'));
console.log(`\n${report.length} problems`);
if (report.length) process.exitCode = 1;
