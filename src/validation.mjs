export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function validateMonitor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Expected a JSON object');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 70) throw new InputError('Name must contain 1–70 characters');
  if (typeof input.url !== 'string' || input.url.length > 2000) throw new InputError('Enter an HTTP or HTTPS URL');
  let url;
  try { url = new URL(input.url); } catch { throw new InputError('Enter a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new InputError('Use HTTP(S), without credentials or a fragment');
  }
  const timeout_ms = input.timeout_ms ?? 1500;
  const interval_ms = input.interval_ms ?? 30000;
  const expected_status = input.expected_status ?? 200;
  if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 10000) throw new InputError('Timeout must be 100–10000 ms');
  if (!Number.isInteger(interval_ms) || interval_ms < 2000 || interval_ms > 3600000) throw new InputError('Interval must be 2000–3600000 ms');
  if (timeout_ms > interval_ms) throw new InputError('Timeout must not exceed the interval');
  if (!Number.isInteger(expected_status) || expected_status < 100 || expected_status > 599) throw new InputError('Expected status must be 100–599');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new InputError('Enabled must be a boolean');
  return { name, url: url.href, timeout_ms, interval_ms, expected_status, enabled: input.enabled !== false };
}
