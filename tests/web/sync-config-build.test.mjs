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
  delete env.SUPABASE_GOOGLE_ENABLED;
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
    const config = {url: 'https://example.invalid', anonKey: 'synthetic-anon', emailEnabled: false, providers: []};
    const present = build(configured, {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey});
    assert.equal(present.status, 0, present.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(configured, 'sync-config.json'), 'utf8')), config);
    const enabled = join(directory, 'enabled');
    const withEmail = build(enabled, {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey, SUPABASE_EMAIL_ENABLED: 'true'});
    assert.equal(withEmail.status, 0, withEmail.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(enabled, 'sync-config.json'), 'utf8')), {...config, emailEnabled: true});
    const google = join(directory, 'google');
    const withGoogle = build(google, {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey, SUPABASE_GOOGLE_ENABLED: 'true'});
    assert.equal(withGoogle.status, 0, withGoogle.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(google, 'sync-config.json'), 'utf8')), {...config, providers: ['google']});
    assert.equal((await readFile(join(configured, 'service-worker.js'), 'utf8')).includes('/sync-config.json'), false);
    for (const settings of [{SUPABASE_URL: config.url}, {SUPABASE_ANON_KEY: config.anonKey}, {SUPABASE_URL: ''}]) {
      const incomplete = build(join(directory, 'partial'), settings);
      assert.notEqual(incomplete.status, 0);
      assert.ok(incomplete.stderr.includes('SUPABASE_URL and SUPABASE_ANON_KEY must be set together'));
    }
    const invalidEmail = build(join(directory, 'invalid-email'), {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey, SUPABASE_EMAIL_ENABLED: 'yes'});
    assert.notEqual(invalidEmail.status, 0);
    assert.ok(invalidEmail.stderr.includes('SUPABASE_EMAIL_ENABLED must be true or false'));
    const invalidGoogle = build(join(directory, 'invalid-google'), {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey, SUPABASE_GOOGLE_ENABLED: 'yes'});
    assert.notEqual(invalidGoogle.status, 0);
    assert.ok(invalidGoogle.stderr.includes('SUPABASE_GOOGLE_ENABLED must be true or false'));
    for (const [outDir, expected] of [[absent, 'Account sync is not configured yet.'], [configured, 'Signing in merges'], [enabled, 'Signing in merges'], [google, 'Signing in merges']]) {
      const {server, origin} = await preview(outDir);
      const context = await browser.newContext();
      try {
        await context.route('https://raw.githubusercontent.com/**', (route) => route.abort());
        let requests = 0;
        let authorize;
        let tokenExchanges = 0;
        let syncRequests = 0;
        await context.route('https://example.invalid/**', (route) => {
          requests++;
          const url = new URL(route.request().url());
          if (url.pathname === '/auth/v1/authorize') {
            authorize = url;
            return route.fulfill({status: 302, headers: {location: `${origin}/?code=synthetic-code`}});
          }
          if (url.pathname === '/auth/v1/token') {
            tokenExchanges++;
            const accessToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({sub: 'synthetic-user', exp: Math.floor(Date.now() / 1000) + 3600})).toString('base64url')}.signature`;
            return route.fulfill({status: 200, headers: {'Access-Control-Allow-Origin': '*'}, json: {access_token: accessToken, token_type: 'bearer', expires_in: 3600, refresh_token: 'synthetic-refresh', user: {id: 'synthetic-user', email: 'person@example.com', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z'}}});
          }
          if (url.pathname.startsWith('/rest/v1/')) {
            syncRequests++;
            return route.fulfill({status: 200, headers: {'Access-Control-Allow-Origin': '*'}, json: url.pathname.includes('/rpc/') ? null : []});
          }
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
          assert.equal(await page.getByRole('button', {name: 'Continue with Google'}).count(), 0);
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
        if (outDir === google) {
          const exchanged = page.waitForResponse((response) => response.url().startsWith('https://example.invalid/auth/v1/token'));
          await page.getByRole('button', {name: 'Continue with Google'}).click();
          await exchanged;
          await page.waitForURL((url) => url.origin === origin && !url.searchParams.has('code'));
          await page.locator('#openSettings').click();
          await page.getByText('Up to date', {exact: true}).waitFor({timeout: 30000});
          assert.equal(authorize.searchParams.get('provider'), 'google');
          assert.equal(authorize.searchParams.get('redirect_to'), origin);
          assert.equal(authorize.searchParams.get('scopes'), 'openid email profile');
          assert.ok(authorize.searchParams.get('code_challenge'));
          assert.equal(tokenExchanges, 1, 'callback exchanges its PKCE code');
          assert.ok(syncRequests > 0, 'the returned session starts account sync');
          assert.equal(await page.locator('#syncSignOut').isVisible(), true);
          await page.evaluate(() => localStorage.clear());
          await page.goto(`${origin}/?error=access_denied&error_description=Google%20sign-in%20was%20cancelled`);
          await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('Sign-in failed: Google sign-in was cancelled'));
          await page.locator('#openSettings').click();
          assert.ok((await page.locator('#syncStatus').innerText()).includes('Sign-in failed: Google sign-in was cancelled'));
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
