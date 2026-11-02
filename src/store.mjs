import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { summarize } from './stats.mjs';
import { InputError, validateMonitor } from './validation.mjs';

export class Store {
  constructor(path = ':memory:', now = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS monitors (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
        expected_status INTEGER NOT NULL, enabled INTEGER NOT NULL,
        demo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        checked_at INTEGER NOT NULL, duration_ms REAL NOT NULL,
        status INTEGER, ok INTEGER NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS checks_monitor ON checks(monitor_id, id DESC);
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL, resolved_at INTEGER, failure_count INTEGER NOT NULL, reason TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident ON incidents(monitor_id) WHERE resolved_at IS NULL;
    `);
  }

  normalize(row) { return row ? { ...row, enabled: !!row.enabled, demo: !!row.demo } : null; }
  list() { return this.db.prepare('SELECT * FROM monitors ORDER BY created_at, id').all().map(row => this.normalize(row)); }
  get(id) { return this.normalize(this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id)); }
  create(input, demo = false) {
    const monitor = validateMonitor(input);
    if (this.list().length >= 20) throw new InputError('The local lab supports at most 20 monitors');
    const id = randomUUID();
    this.db.prepare('INSERT INTO monitors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, monitor.name, monitor.url, monitor.timeout_ms, monitor.interval_ms,
      monitor.expected_status, +monitor.enabled, +demo, this.now(),
    );
    return this.get(id);
  }
  update(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Expected a JSON object');
    const previous = this.get(id);
    if (!previous) throw new InputError('Monitor not found', 404);
    const next = validateMonitor({ ...previous, ...input });
    // Changing the target/expectation starts a fresh measurement series.
    const reset = next.url !== previous.url || next.expected_status !== previous.expected_status;
    this.transaction(() => {
      this.db.prepare('UPDATE monitors SET name=?,url=?,timeout_ms=?,interval_ms=?,expected_status=?,enabled=?,demo=? WHERE id=?').run(
        next.name, next.url, next.timeout_ms, next.interval_ms, next.expected_status, +next.enabled,
        reset ? 0 : +previous.demo, id,
      );
      if (reset) {
        this.db.prepare('DELETE FROM checks WHERE monitor_id=?').run(id);
        this.db.prepare('DELETE FROM incidents WHERE monitor_id=?').run(id);
      }
    });
    return this.get(id);
  }
  remove(id) {
    if (!this.db.prepare('DELETE FROM monitors WHERE id=?').run(id).changes) throw new InputError('Monitor not found', 404);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history(id, limit = 500) {
    return this.db.prepare('SELECT * FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT ?').all(id, limit)
      .reverse().map(row => ({ ...row, ok: !!row.ok }));
  }
  lastChecked(id) { return this.db.prepare('SELECT checked_at FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 1').get(id)?.checked_at ?? null; }
  record(id, result) {
    if (!this.get(id)) return;
    this.transaction(() => {
      const { checked_at = this.now(), duration_ms, status = null, ok, error = null } = result;
      this.db.prepare('INSERT INTO checks(monitor_id,checked_at,duration_ms,status,ok,error) VALUES (?,?,?,?,?,?)')
        .run(id, checked_at, duration_ms, status, +ok, error);
      const open = this.db.prepare('SELECT id FROM incidents WHERE monitor_id=? AND resolved_at IS NULL').get(id);
      if (!ok && !open) {
        this.db.prepare('INSERT INTO incidents(monitor_id,started_at,failure_count,reason) VALUES (?,?,1,?)').run(id, checked_at, error || `HTTP ${status}`);
      } else if (!ok) {
        this.db.prepare('UPDATE incidents SET failure_count=failure_count+1 WHERE id=?').run(open.id);
      } else if (open) {
        this.db.prepare('UPDATE incidents SET resolved_at=? WHERE id=?').run(checked_at, open.id);
      }
      this.db.prepare('DELETE FROM checks WHERE monitor_id=? AND id NOT IN (SELECT id FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 500)').run(id, id);
      this.db.prepare('DELETE FROM incidents WHERE monitor_id=? AND resolved_at IS NOT NULL AND id NOT IN (SELECT id FROM incidents WHERE monitor_id=? ORDER BY id DESC LIMIT 100)').run(id, id);
    });
  }
  dashboard() {
    const monitors = this.list().map(monitor => {
      const history = this.history(monitor.id);
      return { ...monitor, summary: summarize(history), last: history.at(-1) ?? null, history: history.slice(-60) };
    });
    const incidents = this.db.prepare(`SELECT incidents.*,monitors.name,monitors.demo FROM incidents
      JOIN monitors ON monitors.id=incidents.monitor_id ORDER BY started_at DESC,id DESC LIMIT 100`).all();
    const open_incident_count = this.db.prepare('SELECT COUNT(*) AS count FROM incidents WHERE resolved_at IS NULL').get().count;
    return { monitors, incidents, open_incident_count, generated_at: this.now(), retention_checks: 500 };
  }
  close() { this.db.close(); }
}
