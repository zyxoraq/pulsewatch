import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { validateMonitor } from '../src/validation.mjs';

const config = { name: 'Example API', url: 'http://127.0.0.1:9000/health', timeout_ms: 500, interval_ms: 2000 };

test('one incident spans consecutive failures and closes at first recovery', () => {
  let now = 1000;
  const store = new Store(':memory:', () => now);
  try {
    const monitor = store.create(config);
    store.record(monitor.id, { ok: false, duration_ms: 20, status: 503, error: 'Unavailable' });
    now = 3000;
    store.record(monitor.id, { ok: false, duration_ms: 30, status: 503 });
    assert.equal(store.dashboard().incidents.length, 1);
    assert.equal(store.dashboard().incidents[0].failure_count, 2);
    assert.equal(store.dashboard().open_incident_count, 1);
    now = 5000;
    store.record(monitor.id, { ok: true, duration_ms: 15, status: 200 });
    const incident = store.dashboard().incidents[0];
    assert.equal(incident.started_at, 1000);
    assert.equal(incident.resolved_at, 5000);
    assert.equal(store.dashboard().open_incident_count, 0);
    now = 7000;
    store.record(monitor.id, { ok: false, duration_ms: 20, status: 503 });
    assert.equal(store.dashboard().incidents.length, 2);
  } finally { store.close(); }
});

test('history retention bounds summaries and target edits reset measurements', () => {
  const store = new Store();
  try {
    const monitor = store.create(config, true);
    for (let i = 0; i < 510; i++) store.record(monitor.id, { checked_at: i, ok: i >= 10, duration_ms: i, status: i >= 10 ? 200 : 503 });
    assert.equal(store.history(monitor.id).length, 500);
    assert.equal(store.dashboard().monitors[0].summary.uptime, 100);
    store.update(monitor.id, { name: 'Renamed API', enabled: false });
    assert.equal(store.history(monitor.id).length, 500);
    store.update(monitor.id, { url: 'http://127.0.0.1:9001/health' });
    assert.equal(store.history(monitor.id).length, 0);
    assert.equal(store.dashboard().incidents.length, 0);
    assert.equal(store.get(monitor.id).demo, false);
  } finally { store.close(); }
});

test('SQLite data survives reopening and delete cascades to dependent records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulsewatch-test-'));
  const file = join(directory, 'test.sqlite');
  let store = new Store(file);
  try {
    const monitor = store.create(config);
    store.record(monitor.id, { ok: false, duration_ms: 12, status: 500 });
    store.close(); store = new Store(file);
    assert.equal(store.get(monitor.id).name, config.name);
    assert.equal(store.dashboard().incidents.length, 1);
    assert.equal(store.history(monitor.id).length, 1);
    store.remove(monitor.id);
    assert.equal(store.dashboard().incidents.length, 0);
    assert.equal(store.history(monitor.id).length, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('validates protocols, credentials, intervals and input types', () => {
  assert.equal(validateMonitor(config).enabled, true);
  for (const patch of [{ url: 'file:///etc/passwd' }, { url: 'http://user:password@localhost/' }, { url: 'http://localhost/#token' }, { name: '' }, { timeout_ms: 0 }, { timeout_ms: 3000, interval_ms: 2000 }, { interval_ms: 1 }, { expected_status: 999 }, { enabled: 'yes' }]) {
    assert.throws(() => validateMonitor({ ...config, ...patch }));
  }
  assert.throws(() => validateMonitor(null));
});
