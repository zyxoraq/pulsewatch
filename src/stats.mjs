/** Nearest-rank percentile. Empty input deliberately returns null, not zero. */
export function percentile(values, p) {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new RangeError('Percentile must be between 0 and 1');
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function summarize(checks) {
  const successful = checks.filter(check => check.ok);
  const durations = successful.map(check => check.duration_ms);
  return {
    checks: checks.length,
    uptime: checks.length ? successful.length / checks.length * 100 : null,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
  };
}
