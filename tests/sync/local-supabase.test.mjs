import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';

const config = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], {encoding: 'utf8'}));
const api = config.API_URL;
const anon = config.ANON_KEY;

async function request(path, {token = anon, method = 'GET', body, headers = {}} = {}) {
  const response = await fetch(`${api}${path}`, {method, headers: {apikey: anon, Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : null};
}

async function account() {
  const result = await request('/auth/v1/signup', {method: 'POST', body: {email: `${randomUUID()}@example.test`, password: randomUUID()}});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return {id: result.body.user.id, token: result.body.access_token};
}

const event = (id) => ({id, deviceId: 'device', clock: 1, createdAt: '2026-01-01T00:00:00.000Z', kind: 'setting', payload: {key: 'piano-duet.mode', value: 'reading'}});

test('RLS isolates accounts and append-only pushes are idempotent', async () => {
  const [alice, bob] = await Promise.all([account(), account()]);
  const item = event(randomUUID());
  const push = (token, events) => request('/rest/v1/rpc/push_practice_events', {method: 'POST', token, body: {events}});
  assert.equal((await push(alice.token, [item])).status, 204);
  assert.equal((await push(alice.token, [item])).status, 204);
  assert.equal((await push(alice.token, [{...item, payload: {key: 'piano-duet.mode', value: 'duet'}}])).status, 400);
  const own = await request('/rest/v1/practice_events?select=*', {token: alice.token});
  const other = await request('/rest/v1/practice_events?select=*', {token: bob.token});
  assert.equal(own.status, 200);
  assert.equal(own.body.length, 1);
  assert.deepEqual(own.body[0].event, item);
  assert.deepEqual(other.body, []);
  const forged = await request('/rest/v1/practice_events', {method: 'POST', token: bob.token,
    body: {user_id: alice.id, id: randomUUID(), event: item}});
  assert.equal(forged.status, 403);
  const update = await request(`/rest/v1/practice_events?id=eq.${item.id}`, {method: 'PATCH', token: alice.token, body: {event: item}});
  const remove = await request(`/rest/v1/practice_events?id=eq.${item.id}`, {method: 'DELETE', token: alice.token});
  assert.equal(update.status, 403);
  assert.equal(remove.status, 403);
});
