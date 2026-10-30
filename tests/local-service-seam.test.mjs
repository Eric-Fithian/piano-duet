import assert from 'node:assert/strict';
import test from 'node:test';
import {localFetch, localRequest, setLocalService} from '../src/piano_duet/static/practice.mjs';

test('API requests use the injected service while other requests keep browser fetch', async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (path, options) => { requests.push({kind: 'network', path, options}); return Response.json({source: 'network'}); };
  setLocalService({async fetch(path, options) { requests.push({kind: 'local', path, options}); return Response.json({source: 'local'}); }});
  try {
    assert.deepEqual(await localRequest('/api/profile'), {source: 'local'});
    assert.deepEqual(await localRequest('/api/practice/next', {focus: 'reading'}), {source: 'local'});
    assert.deepEqual(await (await localFetch('/samples/C4.mp3')).json(), {source: 'network'});
    assert.equal(requests[0].kind, 'local');
    assert.equal(requests[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[1].options.body), {focus: 'reading'});
    assert.equal(requests[2].kind, 'network');
    setLocalService(null);
    assert.deepEqual(await localRequest('/api/profile'), {source: 'network'});
  } finally {
    setLocalService(null);
    globalThis.fetch = original;
  }
});
