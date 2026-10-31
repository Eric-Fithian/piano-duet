import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {get} from 'node:http';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {chromium} from 'playwright';

const site = resolve('site');
const vite = 'node_modules/vite/bin/vite.js';

function build(outDir, settings) {
  const env = {...process.env};
  delete env.SUPABASE_URL;
  delete env.SUPABASE_ANON_KEY;
  delete env.SUPABASE_EMAIL_ENABLED;
  Object.assign(env, settings);
  return spawnSync(process.execPath, [vite, 'build', '--config', 'vite.config.ts', '--outDir', outDir], {cwd: site, env, encoding: 'utf8'});
}

async function preview(outDir) {
  const probe = createServer();
  await new Promise((ready) => probe.listen(0, '127.0.0.1', ready));
  const port = probe.address().port;
  await new Promise((closed) => probe.close(closed));
  const server = spawn(process.execPath, [vite, 'preview', '--config', 'vite.config.ts', '--outDir', outDir, '--port', String(port), '--strictPort'],
    {cwd: site, stdio: 'ignore'});
  await new Promise((ready, reject) => {
    const deadline = Date.now() + 30000;
    server.once('exit', (code) => reject(new Error(`Preview server exited: ${code}`)));
    const poll = () => {
      if (Date.now() >= deadline) return reject(new Error('Preview server did not start'));
      const request = get(`http://127.0.0.1:${port}/`, (response) => { response.resume(); ready(); });
      request.on('error', () => setTimeout(poll, 100));
    };
    poll();
  });
  return {server, origin: `http://127.0.0.1:${port}`};
}

test('production build serves optional sync configuration and rejects partial configuration', {timeout: 120000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'piano-duet-sync-build-'));
  const browser = await chromium.launch({headless: true});
  try {
    const absent = join(directory, 'absent');
    const missing = build(absent, {});
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(existsSync(join(absent, 'sync-config.json')), false);
    const configured = join(directory, 'configured');
    const config = {url: 'https://example.invalid', anonKey: 'synthetic-anon', emailEnabled: false};
    const present = build(configured, {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey});
    assert.equal(present.status, 0, present.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(configured, 'sync-config.json'), 'utf8')), config);
    const enabled = join(directory, 'enabled');
    const withEmail = build(enabled, {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey, SUPABASE_EMAIL_ENABLED: 'true'});
    assert.equal(withEmail.status, 0, withEmail.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(enabled, 'sync-config.json'), 'utf8')), {...config, emailEnabled: true});
    assert.equal((await readFile(join(configured, 'service-worker.js'), 'utf8')).includes('/sync-config.json'), false);
    for (const settings of [{SUPABASE_URL: config.url}, {SUPABASE_ANON_KEY: config.anonKey}, {SUPABASE_URL: ''}]) {
      const incomplete = build(join(directory, 'partial'), settings);
      assert.notEqual(incomplete.status, 0);
      assert.ok(incomplete.stderr.includes('SUPABASE_URL and SUPABASE_ANON_KEY must be set together'));
    }
    const invalidEmail = build(join(directory, 'invalid-email'), {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey, SUPABASE_EMAIL_ENABLED: 'yes'});
    assert.notEqual(invalidEmail.status, 0);
    assert.ok(invalidEmail.stderr.includes('SUPABASE_EMAIL_ENABLED must be true or false'));
    for (const [outDir, expected] of [[absent, 'Account sync is not configured yet.'], [configured, 'Signing in merges'], [enabled, 'Signing in merges']]) {
      const {server, origin} = await preview(outDir);
      const context = await browser.newContext();
      try {
        await context.route('https://raw.githubusercontent.com/**', (route) => route.abort());
        if (outDir === configured) {
          await context.route('**/sync-config.json', (route) => route.fulfill({json: {...config, providers: ['google']}}));
        }
        let requests = 0;
        await context.route('https://example.invalid/**', (route) => {
          requests++;
          return route.fulfill({status: 200, json: {}});
        });
        const page = await context.newPage();
        await page.goto(origin);
        await page.waitForFunction((text) => document.querySelector('#accountSync')?.textContent.includes(text), expected, {timeout: 30000});
        await page.locator('#openSettings').click();
        assert.equal(await page.locator('#accountSync').isVisible(), true);
        if (outDir === configured) {
          await page.waitForFunction(() => !document.querySelector('#syncEmailUnavailable').hidden);
          assert.equal(await page.locator('#syncSignIn').isVisible(), false);
          assert.ok((await page.locator('#syncEmailUnavailable').innerText()).includes('Email sign-in is not available yet'));
          assert.equal(await page.getByRole('button', {name: 'Continue with Google'}).isVisible(), true);
          await page.locator('#syncSignIn input').evaluate((input) => { input.value = 'person@example.com'; });
          await page.locator('#syncSignIn').evaluate((form) => form.dispatchEvent(new Event('submit', {cancelable: true})));
          assert.equal(await page.locator('#syncStatus').innerText(), 'Email sign-in is not available yet.');
          assert.equal(requests, 0, 'disabled email sign-in must not call Supabase');
        }
        if (outDir === enabled) {
          await page.waitForFunction(() => !document.querySelector('#syncSignIn').hidden);
          await page.locator('#syncSignIn input').fill('person@example.com');
          await page.locator('#syncSignIn button').click();
          await page.waitForFunction(() => document.querySelector('#syncStatus').textContent.includes('Check your email'));
          assert.equal(requests, 1, 'enabled email sign-in sends an OTP request');
        }
      } finally {
        await context.close();
        server.kill('SIGTERM');
      }
    }
  } finally {
    await browser.close();
    await rm(directory, {recursive: true, force: true});
  }
});
