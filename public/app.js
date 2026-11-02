import { createHistoryClient } from './history-client.js';

const $ = selector => document.querySelector(selector);
let dashboard = { monitors: [], incidents: [], running: [] };
let fetching = false, noticeTimer, deleteId;
let historySelection = null, historyExportController = null, historyExportVersion = 0;
const historyClient = createHistoryClient({ onState: renderHistoryState });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function announce(message, error = false) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = message; $('#notice').className = `notice${error ? ' error' : ''}`; $('#notice').hidden = false;
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, error ? 12000 : 6500);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const percent = value => value === null ? '—' : `${value.toFixed(1)}%`;
const ms = value => value === null ? '—' : Math.round(value).toLocaleString();
const date = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function duration(value) {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function badge(label, status) {
  const node = element('span', `badge ${status}`);
  node.append(element('span', 'status-dot'), document.createTextNode(label));
  return node;
}
function action(label, title, callback, className = 'icon-button') {
  const button = element('button', className, label);
  button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await callback(); } catch (error) { announce(error.message, true); }
    finally { button.disabled = false; }
  });
  return button;
}
function monitorCard(monitor) {
  const card = element('article', 'monitor-card');
  const content = element('div', 'card-main');
  const heading = element('div', 'card-heading');
  const title = element('div', 'service-title');
  title.append(element('h3', 'service-name', monitor.name));
  const url = element('div', 'url', monitor.url); url.title = monitor.url; title.append(url);
  if (monitor.demo) title.append(element('span', 'demo-chip', 'DEMO SERVICE'));
  const state = !monitor.enabled ? ['Paused', 'paused'] : !monitor.last ? ['Pending', 'new'] : monitor.last.ok ? ['Healthy', 'up'] : ['Failing', 'down'];
  heading.append(element('div', 'service-icon', '⌁'), title, badge(...state));
  const chart = element('div', 'chart'); chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `${monitor.history.length} recent checks; green is success, orange is failure. Bar height indicates latency.`);
  const maximum = Math.max(100, ...monitor.history.map(check => check.duration_ms));
  if (!monitor.history.length) chart.append(element('span', 'chart-empty', 'Awaiting first observation'));
  for (const check of monitor.history) {
    const bar = element('div', `bar${check.ok ? '' : ' failed'}`);
    bar.style.height = `${Math.max(10, check.duration_ms / maximum * 100)}%`;
    bar.title = `${date(check.checked_at)} · ${check.ok ? 'success' : 'failure'} · ${ms(check.duration_ms)} ms · ${check.status ?? 'no response'}`;
    chart.append(bar);
  }
  const chartLabels = element('div', 'chart-labels');
  chartLabels.append(element('span', '', monitor.history.length ? date(monitor.history[0].checked_at) : 'NO DATA'), element('span', '', 'LATEST →'));
  const stats = element('dl', 'card-stats');
  for (const [label, value, unit] of [['SUCCESS', percent(monitor.summary.uptime), ''], ['P50', ms(monitor.summary.p50), 'ms'], ['P95', ms(monitor.summary.p95), 'ms']]) {
    const item = element('div'); const number = element('dd', '', value);
    if (unit && value !== '—') number.append(element('small', '', unit));
    item.append(element('dt', '', label), number); stats.append(item);
  }
  const message = dashboard.running.includes(monitor.id) ? 'Checking endpoint…' : monitor.last ? (monitor.last.ok ? `HTTP ${monitor.last.status} · ${ms(monitor.last.duration_ms)} ms · response received` : monitor.last.error) : 'Automatic checks start within one second.';
  content.append(heading, chart, chartLabels, stats, element('p', `card-message${monitor.last && !monitor.last.ok ? ' failure' : ''}`, message));
  content.append(action('View history →', `View retained measurements for ${monitor.name}`, () => openHistory(monitor), 'history-open'));
  const footer = element('div', 'card-footer');
  footer.append(element('small', '', `Every ${monitor.interval_ms / 1000}s · ${monitor.timeout_ms}ms timeout`));
  const actions = element('div', 'card-actions');
  actions.append(action('↻', `Check ${monitor.name}`, async () => { await api(`/api/monitors/${monitor.id}/run`, { method: 'POST' }); await refresh(); }));
  actions.append(action(monitor.enabled ? 'Ⅱ' : '▷', `${monitor.enabled ? 'Pause' : 'Resume'} ${monitor.name}`, async () => { await api(`/api/monitors/${monitor.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !monitor.enabled }) }); await refresh(); }));
  actions.append(action('⚙', `Edit ${monitor.name}`, () => openMonitor(monitor)));
  actions.append(action('×', `Remove ${monitor.name}`, () => { deleteId = monitor.id; $('#delete-title').textContent = `Remove ${monitor.name}?`; $('#delete-dialog').showModal(); }));
  footer.append(actions); card.append(content, footer); return card;
}
function render() {
  const { monitors, incidents } = dashboard;
  const total = monitors.reduce((sum, m) => sum + m.summary.checks, 0);
  const successes = monitors.reduce((sum, m) => sum + (m.summary.uptime || 0) / 100 * m.summary.checks, 0);
  const open = dashboard.open_incident_count;
  $('#metric-total').textContent = monitors.length;
  $('#metric-active').textContent = `${monitors.filter(m => m.enabled).length} active · ${monitors.filter(m => !m.enabled).length} paused`;
  $('#metric-uptime').textContent = percent(total ? successes / total * 100 : null);
  $('#metric-incidents').textContent = open;
  $('#metric-checks').textContent = total.toLocaleString();
  $('#incident-caption').textContent = open ? `${open} service${open === 1 ? '' : 's'} awaiting recovery` : 'No active failures';
  $('#service-count').textContent = monitors.length; $('#nav-count').textContent = monitors.length;
  $('#monitor-grid').replaceChildren(...monitors.map(monitorCard));
  $('#empty-state').hidden = !!monitors.length;
  $('#check-all').disabled = !monitors.some(monitor => monitor.enabled);
  $('#no-incidents').hidden = !!incidents.length;
  const rows = incidents.map(incident => {
    const row = element('tr'); const service = element('td');
    service.append(element('span', 'incident-name', incident.name), element('span', 'incident-reason', incident.reason));
    const status = element('td'); status.append(badge(incident.resolved_at === null ? 'Open' : 'Recovered', incident.resolved_at === null ? 'down' : 'up'));
    const started = element('td', '', new Date(incident.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    row.append(service, status, started, element('td', '', duration((incident.resolved_at ?? dashboard.generated_at) - incident.started_at)), element('td', '', incident.failure_count));
    return row;
  });
  $('#incident-list').replaceChildren(...rows);
  $('#last-refresh').textContent = `Updated ${date(dashboard.generated_at)} · refreshes every 3s`;
}
async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    dashboard = await api('/api/dashboard'); render();
    $('#connection').textContent = 'Live connection'; $('#connection').className = 'connection';
  } catch (error) {
    $('#connection').textContent = 'Connection lost'; $('#connection').className = 'connection error';
  } finally { fetching = false; }
}
function openMonitor(monitor) {
  $('#monitor-id').value = monitor?.id || '';
  $('#dialog-title').textContent = monitor ? 'Edit service' : 'Add a service';
  $('#monitor-name').value = monitor?.name || '';
  $('#monitor-url').value = monitor?.url || '';
  $('#monitor-interval').value = (monitor?.interval_ms || 30000) / 1000;
  $('#monitor-timeout').value = monitor?.timeout_ms || 1500;
  $('#monitor-status').value = monitor?.expected_status || 200;
  $('#monitor-enabled').checked = monitor?.enabled !== false;
  $('#form-error').textContent = ''; $('#monitor-dialog').showModal(); $('#monitor-name').focus();
}

function cancelHistoryExport() {
  historyExportVersion++;
  historyExportController?.abort(); historyExportController = null;
  $('#history-export').textContent = '↓ Export CSV';
}
function loadHistory() {
  if (!historySelection) return;
  cancelHistoryExport();
  $('#history-action-status').textContent = '';
  for (const button of $('#history-filters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.filter === historySelection.filter));
  void historyClient.load(historySelection.id, historySelection.filter);
}
function openHistory(monitor) {
  historySelection = { id: monitor.id, filter: 'all' };
  const options = dashboard.monitors.map(item => {
    const option = element('option', '', item.name); option.value = item.id; return option;
  });
  $('#history-monitor').replaceChildren(...options); $('#history-monitor').value = monitor.id;
  $('#history-title').textContent = monitor.name; $('#history-url').textContent = monitor.url;
  $('#history-dialog').showModal();
  loadHistory();
}
function renderHistoryState(state) {
  if (!$('#history-dialog').open || !historySelection || state.id !== historySelection.id || state.filter !== historySelection.filter) return;
  const loading = state.status === 'loading';
  $('#history-refresh').disabled = loading;
  $('#history-export').disabled = state.status !== 'ready' || !state.data?.checks.length;
  $('#history-table-wrap').setAttribute('aria-busy', String(loading));
  $('#history-table-wrap').hidden = true;
  $('#history-rows').replaceChildren();
  $('#history-feedback').hidden = false;
  $('#history-feedback').className = 'history-feedback';
  $('#history-summary').textContent = '';
  $('#history-snapshot').textContent = '';
  if (loading) { $('#history-feedback').textContent = 'Loading retained measurements…'; return; }
  if (state.status === 'error') {
    $('#history-feedback').textContent = `${state.error} Select another monitor or refresh to try again.`;
    $('#history-feedback').classList.add('error'); return;
  }
  const snapshot = state.data;
  $('#history-title').textContent = snapshot.monitor.name;
  $('#history-url').textContent = snapshot.monitor.url;
  $('#history-snapshot').textContent = `Snapshot ${date(snapshot.generated_at)} · ${snapshot.returned_count} of ${snapshot.total_retained} samples`;
  $('#history-summary').textContent = `${snapshot.total_retained} retained · ${percent(snapshot.summary.uptime)} sample success · p50 ${snapshot.summary.p50 === null ? '—' : `${ms(snapshot.summary.p50)} ms`} · p95 ${snapshot.summary.p95 === null ? '—' : `${ms(snapshot.summary.p95)} ms`}`;
  if (!snapshot.checks.length) {
    $('#history-feedback').textContent = snapshot.total_retained ? `No ${state.filter === 'success' ? 'successful' : 'failed'} checks in the retained history.` : 'No measurements yet. Close this view and run a check, then open history again.';
    return;
  }
  const rows = snapshot.checks.map(check => {
    const row = element('tr');
    const timestamp = element('td', 'history-timestamp', new Date(check.checked_at).toLocaleString());
    timestamp.title = new Date(check.checked_at).toISOString();
    const result = element('td'); result.append(badge(check.ok ? 'Success' : 'Failure', check.ok ? 'up' : 'down'));
    row.append(timestamp, result, element('td', '', check.status === null ? 'No response' : String(check.status)), element('td', 'history-duration', `${check.duration_ms.toLocaleString(undefined, { maximumFractionDigits: 2 })} ms`), element('td', 'history-error', check.error || '—'));
    return row;
  });
  $('#history-rows').replaceChildren(...rows);
  $('#history-feedback').hidden = true;
  $('#history-table-wrap').hidden = false;
  $('#history-table-wrap').scrollTop = 0;
}
$('#close-history').addEventListener('click', () => $('#history-dialog').close());
$('#history-dialog').addEventListener('close', () => {
  historySelection = null; historyClient.cancel(); cancelHistoryExport();
});
$('#history-monitor').addEventListener('change', () => {
  if (!historySelection) return;
  historySelection.id = $('#history-monitor').value;
  const monitor = dashboard.monitors.find(item => item.id === historySelection.id);
  $('#history-title').textContent = monitor?.name || 'Service history'; $('#history-url').textContent = monitor?.url || '';
  loadHistory();
});
$('#history-filters').addEventListener('click', event => {
  const button = event.target.closest('button[data-filter]');
  if (!button || !historySelection || historySelection.filter === button.dataset.filter) return;
  historySelection.filter = button.dataset.filter; loadHistory();
});
$('#history-refresh').addEventListener('click', loadHistory);
$('#history-export').addEventListener('click', async () => {
  if (!historySelection) return;
  cancelHistoryExport();
  const version = historyExportVersion;
  const { id, filter } = historySelection;
  historyExportController = new AbortController();
  const isCurrent = () => historyExportVersion === version && $('#history-dialog').open && historySelection?.id === id && historySelection?.filter === filter;
  $('#history-export').disabled = true; $('#history-export').textContent = 'Exporting…';
  $('#history-action-status').textContent = '';
  try {
    const query = new URLSearchParams({ filter, limit: '500' });
    const response = await fetch(`/api/monitors/${encodeURIComponent(id)}/history.csv?${query}`, { signal: AbortSignal.any([historyExportController.signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Export failed'); }
    const blob = await response.blob();
    if (!isCurrent()) return;
    const url = URL.createObjectURL(blob);
    const link = element('a'); link.href = url; link.download = `pulsewatch-${id}-${filter}.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    $('#history-action-status').textContent = 'CSV download requested. It contains the latest saved samples for this filter.';
  } catch (error) {
    if (isCurrent()) $('#history-action-status').textContent = `Could not export: ${error.name === 'TimeoutError' ? 'request timed out' : error.message}. Try again.`;
  } finally {
    if (isCurrent()) { $('#history-export').disabled = false; $('#history-export').textContent = '↓ Export CSV'; historyExportController = null; }
  }
});
$('#add-button').addEventListener('click', () => openMonitor());
$('#close-dialog').addEventListener('click', () => $('#monitor-dialog').close());
$('#cancel-delete').addEventListener('click', () => $('#delete-dialog').close());
$('#confirm-delete').addEventListener('click', async () => {
  const button = $('#confirm-delete'); button.disabled = true;
  try { await api(`/api/monitors/${deleteId}`, { method: 'DELETE' }); $('#delete-dialog').close(); await refresh(); announce('Monitor and its local history removed.'); }
  catch (error) { announce(error.message, true); }
  finally { button.disabled = false; }
});
$('#monitor-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#form-error').textContent = ''; $('#save-button').disabled = true;
  const id = $('#monitor-id').value;
  const payload = { name: $('#monitor-name').value, url: $('#monitor-url').value, interval_ms: Number($('#monitor-interval').value) * 1000, timeout_ms: Number($('#monitor-timeout').value), expected_status: Number($('#monitor-status').value), enabled: $('#monitor-enabled').checked };
  try {
    await api(id ? `/api/monitors/${id}` : '/api/monitors', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    $('#monitor-dialog').close(); await refresh(); announce(id ? 'Monitor updated.' : 'Monitor added. Your first observation is on its way.');
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { $('#save-button').disabled = false; }
});
async function demo(event) {
  event.currentTarget.disabled = true;
  try { await api('/api/demo', { method: 'POST' }); await refresh(); announce('Demo running: healthy responds 200, slow exceeds its 300ms timeout, flaky follows 200 → 503 → 503 → 200.'); }
  catch (error) { announce(error.message, true); }
  finally { $('#demo-button').disabled = false; $('#empty-demo').disabled = false; }
}
$('#demo-button').addEventListener('click', demo); $('#empty-demo').addEventListener('click', demo);
$('#check-all').addEventListener('click', async () => {
  $('#check-all').disabled = true; $('#check-all').textContent = 'Checking…';
  try { await api('/api/run-all', { method: 'POST' }); await refresh(); }
  catch (error) { announce(error.message, true); }
  finally { $('#check-all').disabled = false; $('#check-all').textContent = '↻ Check all'; }
});
await refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
