import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize } from '../src/stats.mjs';

test('nearest-rank percentile has defined empty, single-item and boundary behavior', () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([23], 0.95), 23);
  assert.equal(percentile([9, 1, 5, 3], 0.5), 3);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95), 95);
  assert.equal(percentile([1, 2, 3], 0), 1);
  assert.equal(percentile([1, 2, 3], 1), 3);
  assert.throws(() => percentile([1], 2), RangeError);
});

test('success rate counts failures, latency percentiles exclude them', () => {
  assert.deepEqual(summarize([]), { checks: 0, uptime: null, p50: null, p95: null });
  assert.deepEqual(summarize([
    { ok: true, duration_ms: 10 }, { ok: false, duration_ms: 2000 }, { ok: true, duration_ms: 20 }, { ok: false, duration_ms: 1 },
  ]), { checks: 4, uptime: 50, p50: 10, p95: 20 });
});
