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
    const config = {url: 'https://example.invalid', anonKey: 'synthetic-anon'};
    const present = build(configured, {SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey});
    assert.equal(present.status, 0, present.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(configured, 'sync-config.json'), 'utf8')), config);
    assert.equal((await readFile(join(configured, 'service-worker.js'), 'utf8')).includes('/sync-config.json'), false);
    for (const settings of [{SUPABASE_URL: config.url}, {SUPABASE_ANON_KEY: config.anonKey}, {SUPABASE_URL: ''}]) {
      const incomplete = build(join(directory, 'partial'), settings);
      assert.notEqual(incomplete.status, 0);
      assert.ok(incomplete.stderr.includes('SUPABASE_URL and SUPABASE_ANON_KEY must be set together'));
    }
    for (const [outDir, expected] of [[absent, 'Account sync is not configured yet.'], [configured, 'Signing in merges']]) {
      const {server, origin} = await preview(outDir);
      const context = await browser.newContext();
      try {
        await context.route('https://raw.githubusercontent.com/**', (route) => route.abort());
        const page = await context.newPage();
        await page.goto(origin);
        await page.waitForFunction((text) => document.querySelector('#accountSync')?.textContent.includes(text), expected, {timeout: 30000});
        await page.locator('#openSettings').click();
        assert.equal(await page.locator('#accountSync').isVisible(), true);
        if (outDir === configured) assert.equal(await page.locator('#syncSignIn').isVisible(), true);
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
