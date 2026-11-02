import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';

test('queue respects concurrency and deduplicates the same monitor', async () => {
  const store = new Store();
  let active = 0, maximum = 0, calls = 0;
  const fetchImpl = async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 15)); active--;
    return new Response('', { status: 200 });
  };
  const runner = new Runner(store, { concurrency: 2, fetchImpl });
  try {
    const monitors = Array.from({ length: 6 }, (_, i) => store.create({ name: `API ${i}`, url: `http://localhost/${i}` }));
    const first = runner.run(monitors[0].id);
    assert.equal(first, runner.run(monitors[0].id));
    await Promise.all([first, runner.runAll()]);
    assert.equal(calls, 6);
    assert.equal(maximum, 2);
    for (const monitor of monitors) assert.equal(store.history(monitor.id).length, 1);
  } finally { await runner.stop(); store.close(); }
});

test('scheduler uses injected clock and does not run paused or not-yet-due monitors', async () => {
  let now = 5000, calls = 0;
  const store = new Store(':memory:', () => now);
  const runner = new Runner(store, { now: () => now, fetchImpl: async () => { calls++; return new Response('', { status: 200 }); } });
  try {
    const active = store.create({ name: 'Active', url: 'http://localhost/active', interval_ms: 2000 });
    store.create({ name: 'Paused', url: 'http://localhost/paused', enabled: false });
    runner.schedule(); await Promise.all(runner.pending.values());
    assert.equal(calls, 1);
    now = 6999; runner.schedule(); await Promise.all(runner.pending.values());
    assert.equal(calls, 1);
    now = 7000; runner.schedule(); await Promise.all(runner.pending.values());
    assert.equal(calls, 2);
    assert.equal(store.lastChecked(active.id), 7000);
  } finally { await runner.stop(); store.close(); }
});

test('configuration change during a request discards a stale timeout outcome', async () => {
  const store = new Store(); let release;
  const runner = new Runner(store, { fetchImpl: async () => { await new Promise(resolve => { release = resolve; }); return new Response('', { status: 200 }); } });
  try {
    const monitor = store.create({ name: 'Service', url: 'http://localhost/service' });
    const pending = runner.run(monitor.id);
    store.update(monitor.id, { timeout_ms: 500 }); release(); await pending;
    assert.equal(store.history(monitor.id).length, 0);
  } finally { await runner.stop(); store.close(); }
});
