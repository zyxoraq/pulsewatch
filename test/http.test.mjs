import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

test('real HTTP: create, check, timeout, deterministic outage/recovery, edit and remove', async () => {
  const app = createApp({ scheduling: false });
  const base = await app.listen(0);
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await api('/api/health')).status, 200);
    const healthy = await api('/api/monitors', 'POST', { name: 'Healthy', url: base + '/demo/healthy' });
    assert.equal(healthy.status, 201);
    await api(`/api/monitors/${healthy.data.id}/run`, 'POST');
    assert.equal(app.store.history(healthy.data.id)[0].ok, true);
    const slow = await api('/api/monitors', 'POST', { name: 'Slow', url: base + '/demo/slow', timeout_ms: 100 });
    await api(`/api/monitors/${slow.data.id}/run`, 'POST');
    const timeout = app.store.history(slow.data.id)[0];
    assert.equal(timeout.ok, false); assert.match(timeout.error, /Timeout after 100 ms/); assert.equal(timeout.status, null);
    const flaky = await api('/api/monitors', 'POST', { name: 'Flaky', url: base + '/demo/flaky' });
    for (let i = 0; i < 4; i++) await api(`/api/monitors/${flaky.data.id}/run`, 'POST');
    assert.deepEqual(app.store.history(flaky.data.id).map(check => check.status), [200, 503, 503, 200]);
    const incident = app.store.dashboard().incidents.find(item => item.monitor_id === flaky.data.id);
    assert.equal(incident.failure_count, 2); assert.notEqual(incident.resolved_at, null);
    assert.equal((await api(`/api/monitors/${healthy.data.id}`, 'PATCH', { enabled: false })).data.enabled, false);
    assert.equal((await api(`/api/monitors/${healthy.data.id}`, 'DELETE')).status, 200);
    assert.equal((await api(`/api/monitors/${healthy.data.id}/run`, 'POST')).status, 404);
    assert.equal((await api('/api/dashboard')).data.monitors.length, 2);
  } finally { await app.close(); }
});

test('HTTP boundaries reject cross-origin writes, invalid hosts, traversal, oversized bodies and malformed JSON', async () => {
  const app = createApp({ scheduling: false }); const base = await app.listen(0);
  try {
    const crossOrigin = await fetch(base + '/api/demo', { method: 'POST', headers: { Origin: 'http://attacker.invalid' } });
    assert.equal(crossOrigin.status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(base + '/api/health', { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    const traversal = await fetch(base + '/%2e%2e%2fserver.mjs'); assert.equal(traversal.status, 404);
    const invalid = await fetch(base + '/api/monitors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' }); assert.equal(invalid.status, 400);
    const oversized = await fetch(base + '/api/monitors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(18000) }) }); assert.equal(oversized.status, 413);
    const index = await fetch(base); assert.equal(index.status, 200); assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await index.text(), /Every request tells a story/);
  } finally { await app.close(); }
});

test('demo creation is repeatable without duplicating monitors', async () => {
  const app = createApp({ scheduling: false }); const base = await app.listen(0);
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(base + '/api/demo', { method: 'POST' }); assert.equal(response.status, 201);
    }
    assert.equal(app.store.list().length, 3);
    assert.equal(app.store.list().every(m => m.demo), true);
  } finally { await app.close(); }
});
