import { InputError } from './validation.mjs';

export const HISTORY_FILTERS = ['all', 'success', 'failure'];

export function validateHistoryOptions({ filter = 'all', limit = 500 } = {}) {
  if (!HISTORY_FILTERS.includes(filter)) throw new InputError('Filter must be all, success or failure');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new InputError('Limit must be an integer from 1 to 500');
  return { filter, limit };
}

export function parseHistoryQuery(parameters) {
  for (const key of parameters.keys()) {
    if (!['filter', 'limit'].includes(key)) throw new InputError(`Unknown history parameter: ${key}`);
    if (parameters.getAll(key).length !== 1) throw new InputError(`History parameter must appear once: ${key}`);
  }
  const rawLimit = parameters.get('limit');
  if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) throw new InputError('Limit must be an integer from 1 to 500');
  return validateHistoryOptions({ filter: parameters.get('filter') ?? 'all', limit: rawLimit === null ? 500 : Number(rawLimit) });
}

/** Quote every cell and neutralize formula prefixes, including those hidden by whitespace. */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+\-@＝＋－＠]/u.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function historyCSV({ monitor, checks }) {
  const rows = [['sample_id', 'monitor_id', 'monitor_name', 'url', 'checked_at_utc', 'result', 'http_status', 'duration_ms', 'error']];
  for (const check of checks) {
    rows.push([
      check.id, monitor.id, monitor.name, monitor.url, new Date(check.checked_at).toISOString(),
      check.ok ? 'success' : 'failure', check.status, check.duration_ms, check.error,
    ]);
  }
  // UTF-8 BOM helps spreadsheet applications recognize names in non-Latin scripts.
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
