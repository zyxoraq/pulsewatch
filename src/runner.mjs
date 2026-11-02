import { performance } from 'node:perf_hooks';

export class Runner {
  constructor(store, { concurrency = 3, fetchImpl = fetch, now = Date.now } = {}) {
    this.store = store; this.concurrency = concurrency; this.fetchImpl = fetchImpl; this.now = now;
    this.pending = new Map(); this.queue = []; this.active = 0; this.controllers = new Set(); this.stopped = false;
  }
  run(id) {
    if (this.stopped) return Promise.resolve();
    if (this.pending.has(id)) return this.pending.get(id);
    let done;
    const promise = new Promise(resolve => { done = resolve; });
    this.pending.set(id, promise);
    this.queue.push({ id, done });
    this.pump();
    return promise;
  }
  pump() {
    while (!this.stopped && this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      this.active++;
      this.check(task.id).catch(error => console.error('Check storage error:', error.message)).finally(() => {
        this.active--; this.pending.delete(task.id); task.done(); this.pump();
      });
    }
  }
  async check(id) {
    const monitor = this.store.get(id);
    if (!monitor) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, monitor.timeout_ms);
    const start = performance.now();
    let status = null, ok = false, error = null;
    try {
      const response = await this.fetchImpl(monitor.url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'PulseWatch/1.0 (local-reliability-lab)' },
      });
      status = response.status;
      ok = status === monitor.expected_status;
      if (!ok) error = `Expected HTTP ${monitor.expected_status}, received ${status}`;
      await response.body?.cancel();
    } catch (cause) {
      error = timedOut ? `Timeout after ${monitor.timeout_ms} ms` : `Connection failed: ${cause.cause?.code || cause.name || 'network error'}`;
    } finally {
      clearTimeout(timeout); this.controllers.delete(controller);
    }
    if (this.stopped) return;
    const current = this.store.get(id);
    if (!current || current.url !== monitor.url || current.expected_status !== monitor.expected_status || current.timeout_ms !== monitor.timeout_ms) return;
    this.store.record(id, { checked_at: this.now(), duration_ms: Math.round((performance.now() - start) * 100) / 100, status, ok, error });
  }
  runAll() { return Promise.all(this.store.list().filter(m => m.enabled).map(m => this.run(m.id))); }
  schedule() {
    for (const monitor of this.store.list()) {
      const last = this.store.lastChecked(monitor.id);
      if (monitor.enabled && (last === null || this.now() - last >= monitor.interval_ms)) void this.run(monitor.id);
    }
  }
  start() { this.timer = setInterval(() => this.schedule(), 1000); this.timer.unref(); }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const task of this.queue.splice(0)) { this.pending.delete(task.id); task.done(); }
    for (const controller of this.controllers) controller.abort();
    await Promise.all(this.pending.values());
  }
}
