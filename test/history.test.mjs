import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../src/store.mjs';
import { csvCell, historyCSV, parseHistoryQuery } from '../src/history.mjs';
import { createApp } from '../server.mjs';

test('history selects newest matching retained samples, bounds limits and keeps summary unfiltered', () => {
  const store = new Store(':memory:', () => 2000000);
  try {
    const monitor = store.create({ name: 'API', url: 'http://localhost/test' });
    for (let i = 0; i < 510; i++) store.record(monitor.id, { checked_at: i * 1000, duration_ms: i, ok: i % 2 === 0, status: i % 2 === 0 ? 200 : 503 });
    const all = store.historyDetails(monitor.id);
    assert.equal(all.total_retained, 500); assert.equal(all.checks.length, 500);
    assert.equal(all.order, 'newest-first'); assert.equal(all.checks[0].checked_at, 509000); assert.equal(all.checks.at(-1).checked_at, 10000);
    const failures = store.historyDetails(monitor.id, { filter: 'failure', limit: 3 });
    assert.deepEqual(failures.checks.map(check => check.checked_at), [509000, 507000, 505000]);
    assert.equal(failures.matched_count, 250); assert.equal(failures.returned_count, 3);
    assert.deepEqual(failures.summary, all.summary); assert.equal(failures.summary.uptime, 50);
    assert.deepEqual(store.historyDetails(monitor.id, { filter: 'success', limit: 2 }).checks.map(check => check.checked_at), [508000, 506000]);
    assert.throws(() => store.historyDetails(monitor.id, { limit: 501 }), /Limit/);
    assert.throws(() => store.historyDetails(monitor.id, { filter: 'unknown' }), /Filter/);
  } finally { store.close(); }
});

test('CSV quotes separators/newlines/quotes, preserves Unicode and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('a,"b"\r\nc'), '"a,""b""\r\nc"');
  for (const value of ['=1+1', '+SUM(1,2)', '-2+3', '@SUM(A1:A2)', '  =1', '\t=1', '\r=1', '\u0000=1', '\uFEFF=1', '\tplain', '＝SUM(1,2)', ' ＋1', '－1', '＠SUM(A1:A2)']) {
    assert.equal(csvCell(value), `"'${value.replaceAll('"', '""')}"`);
  }
  assert.equal(csvCell('Normal API'), '"Normal API"'); assert.equal(csvCell(null), '""'); assert.equal(csvCell(2.75), '"2.75"');
  const csv = historyCSV({
    monitor: { id: 'abc', name: '=SUM(1,2)', url: 'http://localhost/?a=1,b=2' },
    checks: [{ id: 7, checked_at: 0, ok: false, status: null, duration_ms: 100.25, error: 'Ошибка, "timeout"\r\nsecond line' }],
  });
  assert.ok(csv.startsWith('\uFEFF"sample_id"'));
  assert.ok(csv.endsWith('"7","abc","\'=SUM(1,2)","http://localhost/?a=1,b=2","1970-01-01T00:00:00.000Z","failure","","100.25","Ошибка, ""timeout""\r\nsecond line"\r\n'));
});

test('query parsing rejects ambiguous, unsupported and unbounded history arguments', () => {
  assert.deepEqual(parseHistoryQuery(new URLSearchParams()), { filter: 'all', limit: 500 });
  assert.deepEqual(parseHistoryQuery(new URLSearchParams('filter=failure&limit=5')), { filter: 'failure', limit: 5 });
  for (const query of ['filter=', 'filter=failed', 'filter=all&filter=failure', 'limit=0', 'limit=-1', 'limit=501', 'limit=1.5', 'limit=Infinity', 'limit=01', 'limit=1e2', 'limit=', 'limit=5&limit=5', 'offset=1', 'limit=%201']) {
    assert.throws(() => parseHistoryQuery(new URLSearchParams(query)), { status: 400 }, query);
  }
});

test('HTTP history and CSV share filters, survive edits accurately and follow deletion lifecycle', async () => {
  const app = createApp({ scheduling: false, now: () => 60000 }); const base = await app.listen(0);
  const json = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const created = await json('/api/monitors', 'POST', { name: '=SUM(1,2)', url: `${base}/demo/healthy`, timeout_ms: 100, enabled: false });
    const id = created.data.id; const route = `/api/monitors/${id}/history`;
    assert.equal(created.status, 201);
    const empty = await json(route);
    assert.equal(empty.status, 200); assert.equal(empty.data.returned_count, 0); assert.equal(empty.data.summary.uptime, null);
    const emptyCsv = await fetch(base + route + '.csv?filter=failure');
    assert.equal((await emptyCsv.text()).split('\r\n').length, 2);
    app.store.record(id, { checked_at: 1000, duration_ms: 101.25, status: null, ok: false, error: 'Timeout after 100 ms' });
    app.store.record(id, { checked_at: 2000, duration_ms: 15, status: 503, ok: false, error: '=HYPERLINK("test")' });
    app.store.record(id, { checked_at: 3000, duration_ms: 10, status: 200, ok: true });
    await json(`/api/monitors/${id}`, 'PATCH', { timeout_ms: 1000 });
    const history = (await json(route + '?filter=failure&limit=1')).data;
    assert.equal(history.monitor.timeout_ms, 1000);
    assert.equal(history.total_retained, 3); assert.equal(history.matched_count, 2); assert.equal(history.checks[0].status, 503);
    const all = (await json(route)).data;
    assert.equal(all.checks.at(-1).error, 'Timeout after 100 ms');
    assert.equal(all.checks.at(-1).status, null);
    const csvResponse = await fetch(base + route + '.csv?filter=failure&limit=1');
    assert.equal(csvResponse.status, 200);
    assert.equal(csvResponse.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(csvResponse.headers.get('content-disposition'), `attachment; filename="pulsewatch-${id}-failure.csv"`);
    assert.equal(csvResponse.headers.get('cache-control'), 'no-store');
    assert.equal(csvResponse.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await csvResponse.arrayBuffer());
    assert.equal(Number(csvResponse.headers.get('content-length')), bytes.length);
    assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
    const csv = bytes.toString('utf8');
    assert.ok(csv.includes('"\'=SUM(1,2)"')); assert.ok(csv.includes('"\'=HYPERLINK(""test"")"'));
    assert.equal(csv.split('\r\n').length, 3); assert.ok(csv.includes('"503"')); assert.ok(!csv.includes('Timeout after 100 ms'));
    assert.equal((await json(route + '?filter=success')).data.checks[0].status, 200);
    await json(`/api/monitors/${id}`, 'PATCH', { expected_status: 204 });
    assert.equal((await json(route)).data.total_retained, 0);
    app.store.record(id, { checked_at: 4000, duration_ms: 11, status: 204, ok: true });
    await json(`/api/monitors/${id}`, 'PATCH', { url: `${base}/demo/flaky` });
    assert.equal((await json(route)).data.total_retained, 0);
    await json(`/api/monitors/${id}`, 'DELETE');
    assert.equal((await json(route)).status, 404);
    assert.equal((await fetch(base + route + '.csv')).status, 404);
  } finally { await app.close(); }
});

test('history endpoints enforce query validation, missing monitors and Host/Origin protections', async () => {
  const app = createApp({ scheduling: false }); const base = await app.listen(0);
  try {
    const monitor = app.store.create({ name: 'API', url: base + '/demo/healthy' });
    for (const suffix of ['/history', '/history.csv']) {
      const path = `/api/monitors/${monitor.id}${suffix}`;
      for (const query of ['filter=failed', 'limit=501', 'limit=0', 'limit=1.2', 'filter=all&filter=success', 'limit=1&limit=2', 'sort=asc']) {
        const response = await fetch(`${base}${path}?${query}`);
        assert.equal(response.status, 400, `${suffix}?${query}`); assert.ok((await response.json()).error);
      }
      const foreign = await fetch(base + path, { headers: { Origin: 'http://attacker.invalid' } }); assert.equal(foreign.status, 403);
      const hostStatus = await new Promise((resolve, reject) => {
        http.get(base + path, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
      });
      assert.equal(hostStatus, 403);
      assert.equal((await fetch(base + `/api/monitors/00000000-0000-0000-0000-000000000000${suffix}`)).status, 404);
    }
  } finally { await app.close(); }
});
