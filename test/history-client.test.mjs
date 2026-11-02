import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryClient } from '../public/history-client.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const response = data => ({ ok: true, json: async () => data });

test('switching monitor/filter aborts the old fetch and ignores late old responses', async () => {
  const first = deferred(), second = deferred(), calls = [], states = [];
  const client = createHistoryClient({ fetchImpl: (url, options) => {
    calls.push({ url, signal: options.signal }); return calls.length === 1 ? first.promise : second.promise;
  }, onState: state => states.push(state) });
  const old = client.load('first-monitor', 'all');
  const current = client.load('second-monitor', 'failure');
  assert.equal(calls[0].signal.aborted, true);
  assert.match(calls[1].url, /second-monitor\/history\?filter=failure&limit=500$/);
  second.resolve(response({ marker: 'current' })); await current;
  first.resolve(response({ marker: 'stale' })); await old;
  assert.deepEqual(states.filter(state => state.status === 'ready').map(state => state.data.marker), ['current']);
});

test('closing history prevents pending success or error from changing the view', async () => {
  for (const ok of [true, false]) {
    const pending = deferred(); const states = [];
    const client = createHistoryClient({ fetchImpl: () => pending.promise, onState: state => states.push(state) });
    const request = client.load('monitor', 'success'); client.cancel();
    pending.resolve({ ok, json: async () => ok ? { checks: [] } : { error: 'Monitor not found' } }); await request;
    assert.deepEqual(states.map(state => state.status), ['loading']);
  }
});

test('current request errors surface and can be retried for the same monitor', async () => {
  const states = []; let calls = 0;
  const client = createHistoryClient({ fetchImpl: async () => ++calls === 1 ? { ok: false, status: 404, json: async () => ({ error: 'Monitor not found' }) } : response({ checks: [] }), onState: state => states.push(state) });
  await client.load('monitor', 'all'); await client.load('monitor', 'all');
  assert.deepEqual(states.map(state => state.status), ['loading', 'error', 'loading', 'ready']);
  assert.equal(states[1].error, 'Monitor not found');
});
