import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {startTestServer} from '../web/server.mjs';

const config = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], {encoding: 'utf8'}));
const staticBase = `/@fs${resolve('src/piano_duet/static')}`;

function sampleWave() {
  const bytes = Buffer.alloc(44 + 1600);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
  return bytes;
}

async function signIn(page, email) {
  await page.locator('#openSettings').click();
  await page.locator('#syncSignIn input').fill(email);
  await page.locator('#syncSignIn button').click();
  await page.getByText('Check your email for a sign-in link.').waitFor();
  const list = await (await fetch(`${config.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
  assert.ok(list.messages.length);
  const message = await (await fetch(`${config.MAILPIT_URL}/api/v1/message/${list.messages[0].ID}`)).json();
  // Email text separates the verification URL from its surrounding prose with whitespace.
  const link = message.Text.split(/\s+/).find((word) => word.startsWith('http'));
  assert.ok(link, 'The sign-in email must contain a link');
  await page.goto(link);
  await page.waitForURL((url) => url.origin !== config.API_URL, {timeout: 15000});
  await page.waitForFunction(() => document.querySelector('#practiceTitle')?.textContent === 'C major scale', null, {timeout: 30000});
  await page.locator('#openSettings').click();
  await page.getByText('Up to date', {exact: true}).waitFor({timeout: 30000});
  await page.locator('#settingsDialog').evaluate((dialog) => dialog.close());
}

test('two signed-in devices rebuild the same progress after practising offline', {timeout: 120000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'piano-duet-sync-'));
  const {server, port} = await startTestServer();
  const contexts = [];
  try {
    const bytes = sampleWave();
    const sample = {pitch: 60, file: 'C4.mp3', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
    const email = `${randomUUID()}@example.test`;
    const pages = [];
    for (const name of ['first', 'second']) {
      const context = await chromium.launchPersistentContext(join(directory, name), {headless: true});
      contexts.push(context);
      await context.route('**/sync-config.json', (route) => route.fulfill({json: {url: config.API_URL, anonKey: config.ANON_KEY}}));
      await context.route('**/src/piano-samples.ts', (route) => route.fulfill({contentType: 'text/javascript',
        body: `export const SAMPLE_REVISION = "sync-fixture"; export const PIANO_SAMPLES = ${JSON.stringify([sample])};`}));
      await context.route('**/src/browser-inference.ts', (route) => route.fulfill({contentType: 'text/javascript',
        body: 'export class BrowserInference { async createSession() { return {run: async () => ({notes: window.syncDrillNotes})}; } }'}));
      await context.route('https://raw.githubusercontent.com/**/sync-fixture/samples/piano/C4.mp3', (route) => route.fulfill({body: bytes,
        headers: {'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'}}));
      const page = await context.newPage();
      pages.push(page);
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => document.querySelector('#practiceTitle')?.textContent === 'C major scale', null, {timeout: 30000});
      await signIn(page, email);
    }
    await Promise.all(contexts.map((context) => context.setOffline(true)));
    for (const [index, page] of pages.entries()) {
      await page.evaluate(async ({path, index}) => {
        const {localFetch, localRequest} = await import(`${path}/practice.mjs`);
        const difficulty = document.querySelector('#difficulty');
        for (let i = 0; i < (index === 0 ? 103 : 1); i++) {
          difficulty.value = String(2 + (index + i) % 2);
          difficulty.dispatchEvent(new Event('change'));
        }
        document.querySelector('#gate').value = String(-40 - index);
        const task = await localRequest('/api/practice/next', {focus: 'reading', step_by_step: true});
        const groups = task.target.map((note, index) => [{pitch: note.pitch, start: 1 + index, velocity: 80, confidence: 0.95}]);
        await localRequest('/api/reading/complete', {task: task.id, attempt: crypto.randomUUID(), groups, interruptions: [], threshold: 0.8});
        const session = crypto.randomUUID();
        for (let take = 0; take < 3; take++) {
          const drill = await localRequest('/api/drills/next', {drill: 'scale', variant: 'major', tonic: 0, hands: 'right', octaves: 1, practice: 'even'});
          window.syncDrillNotes = drill.target.map(({pitch, start, duration, velocity}) => ({pitch, start, duration, velocity}));
          const params = new URLSearchParams({mode: 'drills', session, task: drill.id, attempt: crypto.randomUUID()});
          const response = await localFetch(`/api/respond?${params}`, {method: 'POST', body: new Float32Array(3200).buffer});
          if (!response.ok) throw new Error(`Drill request failed: ${response.status}`);
          const updates = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
          if (updates.some((update) => update.type === 'error')) throw new Error(JSON.stringify(updates));
        }
      }, {path: staticBase, index});
      await page.locator('#libraryMode').click();
      const title = `Offline song ${index}`;
      const score = `<score-partwise><work><work-title>${title}</work-title></work><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`;
      await page.locator('#libraryFile').setInputFiles({name: `song-${index}.musicxml`, mimeType: 'application/xml', buffer: Buffer.from(score)});
      await page.getByText(title, {exact: true}).waitFor({timeout: 15000});
    }
    await Promise.all(contexts.map((context) => context.setOffline(false)));
    for (const page of pages) {
      await page.locator('#openSettings').click();
      await page.locator('#syncNow').click();
      await page.getByText('Up to date', {exact: true}).waitFor({timeout: 30000});
    }
    await pages[0].locator('#syncNow').click();
    await pages[0].getByText('Up to date', {exact: true}).waitFor({timeout: 30000});
    for (const page of pages) {
      await page.locator('#settingsDialog').evaluate((dialog) => dialog.close());
      await page.locator('#openProfile').click();
      await page.waitForFunction(() => document.querySelector('#profileSummary')?.textContent.includes('8 included attempts'), null, {timeout: 30000});
    }
    const profiles = await Promise.all(pages.map((page) => page.evaluate(async (path) => {
      const {localRequest} = await import(`${path}/practice.mjs`);
      const profile = await localRequest('/api/profile');
      delete profile.generated_at;
      return profile;
    }, staticBase)));
    assert.deepEqual(profiles[0], profiles[1]);
    assert.equal(profiles[0].reading.xp.xp, 60);
    assert.equal(profiles[0].recent.length, 8);
    const drills = await Promise.all(pages.map((page) => page.evaluate(async (path) => {
      const {localRequest} = await import(`${path}/practice.mjs`);
      return localRequest('/api/drills');
    }, staticBase)));
    assert.deepEqual(drills[0], drills[1]);
    assert.ok(Object.keys(drills[0].progress).length);
    for (const page of pages) {
      const library = await page.evaluate(async (path) => {
        const {localRequest} = await import(`${path}/practice.mjs`);
        return localRequest('/api/library');
      }, staticBase);
      assert.deepEqual(library.songs.map((song) => song.title).sort(), ['Offline song 0', 'Offline song 1']);
    }
    const settings = await Promise.all(pages.map((page) => page.evaluate(() => ({difficulty: document.querySelector('#difficulty').value, gate: document.querySelector('#gate').value}))));
    assert.equal(settings[0].difficulty, settings[1].difficulty);
    assert.deepEqual(settings.map((setting) => setting.gate), ['-40', '-41']);
    await pages[0].locator('#profileDialog').evaluate((dialog) => dialog.close());
    await pages[0].locator('#openSettings').click();
    await pages[0].locator('#syncSignOut').click();
    await pages[0].getByText('Not signed in', {exact: true}).waitFor();
    await pages[1].locator('#profileDialog').evaluate((dialog) => dialog.close());
    await pages[1].locator('#openSettings').click();
    await pages[1].locator('#syncNow').click();
    await pages[1].getByText('Up to date', {exact: true}).waitFor();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    server.kill('SIGTERM');
    await rm(directory, {recursive: true, force: true});
  }
});
