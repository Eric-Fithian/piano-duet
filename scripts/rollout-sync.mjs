import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const token = accessToken();
  if (options.redirectsOnly) {
    await updateRedirects(token, options.projectRef, options.vercelScope);
    return;
  }
  const organization = await management(token, `/v1/organizations/${encodeURIComponent(options.organization)}`);
  if (typeof organization.id !== 'string' || !organization.id) throw new Error('Supabase returned an invalid organization.');
  if (organization.plan !== 'free') throw new Error('The selected Supabase organization is not on the Free plan.');
  const scope = options.vercelScope;
  run('vercel', ['project', 'inspect', 'piano-duet', '--scope', scope, '--non-interactive']);
  const existing = JSON.parse(run('vercel', ['env', 'ls', '--project', 'piano-duet', '--scope', scope, '--format', 'json', '--non-interactive'], {capture: true}));
  if (!Array.isArray(existing.envs)) throw new Error('Unexpected Vercel environment list.');
  if (existing.envs.some((entry) => ['SUPABASE_URL', 'SUPABASE_ANON_KEY'].includes(entry.key))) {
    throw new Error('Vercel already has a Supabase URL or anon key. Inspect the existing values and targets before changing them.');
  }
  let password = process.env.SUPABASE_DB_PASSWORD;
  let project;
  if (options.projectRef) {
    if (!password) throw new Error('Set SUPABASE_DB_PASSWORD for the existing project.');
    project = await management(token, `/v1/projects/${options.projectRef}`);
    if (project.ref !== options.projectRef && project.id !== options.projectRef) throw new Error('Supabase returned the wrong project.');
    if (project.organization_slug !== options.organization && project.organization_id !== organization.id) {
      throw new Error('The project does not belong to the selected organization.');
    }
  } else {
    const projects = await management(token, '/v1/projects');
    if (!Array.isArray(projects)) throw new Error('Unexpected Supabase project list.');
    if (projects.some((item) => item.organization_id === organization.id && item.name === options.projectName)) {
      throw new Error('A project with this name already exists in the organization; use --project-ref to select it.');
    }
    password ||= randomBytes(32).toString('base64url');
    project = await management(token, '/v1/projects', {method: 'POST', body: {
      organization_slug: options.organization, name: options.projectName, region: options.region, db_pass: password,
    }});
  }
  const ref = project.ref || project.id;
  // Supabase project references contain exactly 20 lowercase letters.
  if (typeof ref !== 'string' || !/^[a-z]{20}$/.test(ref)) throw new Error('Invalid Supabase project reference.');
  console.log(`Preparing Supabase project ${ref} in ${options.organization}.`);
  for (let attempt = 0; ; attempt++) {
    project = await management(token, `/v1/projects/${ref}`);
    if (project.status === 'ACTIVE_HEALTHY') break;
    if (project.status !== 'COMING_UP' || attempt >= 60) throw new Error(`Supabase project is not ready: ${project.status}`);
    await delay(5000);
  }
  const childEnv = {...process.env, SUPABASE_DB_PASSWORD: password};
  run('supabase', ['link', '--project-ref', ref, '--yes'], {env: childEnv});
  run('supabase', ['db', 'push', '--linked', '--skip-vault', '--yes'], {env: childEnv});
  const redirects = redirectUrls(scope);
  const auth = {site_url: 'https://piano-duet.vercel.app', uri_allow_list: redirects.join(','),
    external_email_enabled: true, disable_signup: false, mailer_autoconfirm: false,
    external_apple_enabled: false, external_google_enabled: false};
  await management(token, `/v1/projects/${ref}/config/auth`, {method: 'PATCH', body: auth});
  const applied = await management(token, `/v1/projects/${ref}/config/auth`);
  for (const [key, value] of Object.entries(auth)) {
    const matches = key === 'uri_allow_list' && typeof applied[key] === 'string'
      ? JSON.stringify(applied[key].split(',').map((item) => item.trim()).sort()) === JSON.stringify(redirects.toSorted())
      : applied[key] === value;
    if (!matches) throw new Error(`Supabase did not apply auth setting ${key}.`);
  }
  const keys = JSON.parse(run('supabase', ['projects', 'api-keys', '--project-ref', ref, '-o', 'json'], {capture: true}));
  if (!Array.isArray(keys)) throw new Error('Unexpected Supabase API key list.');
  const anon = keys.filter((key) => key.name === 'anon');
  if (anon.length !== 1 || typeof anon[0].api_key !== 'string' || !anon[0].api_key) throw new Error('Supabase did not return exactly one anon key.');
  for (const [name, value] of [['SUPABASE_URL', `https://${ref}.supabase.co`], ['SUPABASE_ANON_KEY', anon[0].api_key]]) {
    run('vercel', ['env', 'add', name, 'production,preview', '--project', 'piano-duet', '--scope', scope, '--no-sensitive', '--yes'], {input: value});
  }
  console.log('Configuration is ready. New production and preview builds are needed to publish sync-config.json.');
}

function redirectUrls(scope) {
  const production = 'https://piano-duet.vercel.app';
  const preview = `https://piano-duet-*-${scope}.vercel.app`;
  return [production, `${production}/`, preview, `${preview}/**`];
}

async function updateRedirects(token, ref, scope) {
  const path = `/v1/projects/${ref}/config/auth`;
  const current = await management(token, path);
  if (typeof current.uri_allow_list !== 'string') throw new Error('Unexpected Supabase redirect allow-list.');
  const redirects = [...new Set([...current.uri_allow_list.split(',').map((item) => item.trim()).filter(Boolean), ...redirectUrls(scope)])];
  await management(token, path, {method: 'PATCH', body: {uri_allow_list: redirects.join(',')}});
  const applied = await management(token, path);
  if (typeof applied.uri_allow_list !== 'string') throw new Error('Unexpected Supabase redirect allow-list after update.');
  const actual = applied.uri_allow_list.split(',').map((item) => item.trim());
  if (redirects.some((url) => !actual.includes(url))) throw new Error('Supabase did not apply every redirect URL.');
  console.log(`Updated redirect allow-list for ${ref}: ${actual.join(', ')}`);
}

function parseArguments(args) {
  const options = {organization: '', projectRef: '', projectName: 'piano-duet', region: 'us-east-2', vercelScope: 'eric-fithians-projects', redirectsOnly: false};
  const names = {'--organization': 'organization', '--project-ref': 'projectRef', '--project-name': 'projectName',
    '--region': 'region', '--vercel-scope': 'vercelScope'};
  for (let index = 0; index < args.length;) {
    if (args[index] === '--redirects-only') { options.redirectsOnly = true; index++; continue; }
    const key = names[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[index]}`);
    options[key] = args[index + 1];
    index += 2;
  }
  if (options.redirectsOnly && !options.projectRef) throw new Error('Specify the existing project with --project-ref.');
  if (!options.redirectsOnly && !options.organization) throw new Error('Specify the Free-plan Supabase organization with --organization.');
  // A Vercel team slug is a single DNS label used in the preview redirect pattern.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.vercelScope)) throw new Error('Invalid Vercel scope.');
  // Supabase project references contain exactly 20 lowercase letters.
  if (options.projectRef && !/^[a-z]{20}$/.test(options.projectRef)) throw new Error('Invalid Supabase project reference.');
  return options;
}

function accessToken() {
  let token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) token = run('security', ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'], {capture: true}).trim();
  if (token.startsWith('go-keyring-base64:')) token = Buffer.from(token.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  if (!token) throw new Error('Supabase login is required.');
  return token;
}

function run(command, args, {capture = false, input, env = process.env} = {}) {
  const childEnv = {...env};
  if (command === 'vercel') {
    delete childEnv.SUPABASE_ACCESS_TOKEN;
    delete childEnv.SUPABASE_DB_PASSWORD;
  }
  const result = spawnSync(command, args, {env: childEnv, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit']});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed with status ${result.status}.`);
  return result.stdout;
}

async function management(token, path, {method = 'GET', body} = {}) {
  const response = await fetch(`https://api.supabase.com${path}`, {method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  if (!response.ok) throw new Error(`Supabase Management API ${method} ${path} failed: ${response.status}.`);
  if (response.status === 204) return null;
  return response.json();
}

await main();
