import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './src/store.mjs';
import { Runner } from './src/runner.mjs';
import { InputError } from './src/validation.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

async function readJSON(request) {
  if (!String(request.headers['content-type']).startsWith('application/json')) throw new InputError('Use application/json', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new InputError('Request body exceeds 16 KiB', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError('Invalid JSON'); }
}

export function createApp({ dbPath = ':memory:', scheduling = true, now = Date.now } = {}) {
  const store = new Store(dbPath, now);
  const runner = new Runner(store, { now });
  let flakyCount = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    try {
      const port = server.address()?.port;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!hosts.has(request.headers.host)) throw new InputError('Invalid Host header. Use localhost or 127.0.0.1.', 403);
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) throw new InputError('Cross-origin requests are not allowed', 403);
      const url = new URL(request.url, `http://${request.headers.host}`);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/api/health') return send(200, { status: 'ok', service: 'pulsewatch' });
      if (request.method === 'GET' && path === '/api/dashboard') {
        return send(200, { ...store.dashboard(), running: [...runner.pending.keys()] });
      }
      if (request.method === 'POST' && path === '/api/monitors') return send(201, store.create(await readJSON(request)));
      if (request.method === 'POST' && path === '/api/run-all') {
        await runner.runAll();
        return send(200, { ok: true });
      }
      if (request.method === 'POST' && path === '/api/demo') {
        const base = `http://127.0.0.1:${port}`;
        const examples = [
          { name: 'Demo / storefront API', url: `${base}/demo/healthy`, timeout_ms: 1500, interval_ms: 6000 },
          { name: 'Demo / slow inventory', url: `${base}/demo/slow`, timeout_ms: 300, interval_ms: 6000 },
          { name: 'Demo / flaky checkout', url: `${base}/demo/flaky`, timeout_ms: 1500, interval_ms: 6000 },
        ];
        const existing = store.list();
        const missing = examples.filter(example => !existing.some(monitor => monitor.url === example.url));
        if (existing.length + missing.length > 20) throw new InputError('Remove a monitor to make room for the demo services');
        for (const example of missing) store.create(example, true);
        await runner.runAll();
        return send(201, { ok: true });
      }
      const match = /^\/api\/monitors\/([a-f0-9-]+)(\/run)?$/.exec(path);
      if (match) {
        const [, id, run] = match;
        if (!store.get(id)) throw new InputError('Monitor not found', 404);
        if (run && request.method === 'POST') { await runner.run(id); return send(200, { ok: true }); }
        if (!run && request.method === 'PATCH') return send(200, store.update(id, await readJSON(request)));
        if (!run && request.method === 'DELETE') { store.remove(id); return send(200, { ok: true }); }
      }
      if (request.method === 'GET' && path === '/demo/healthy') return send(200, { demo: true, status: 'healthy' });
      if (request.method === 'GET' && path === '/demo/slow') {
        await new Promise(resolve => setTimeout(resolve, 600));
        if (!response.destroyed) send(200, { demo: true, latency_ms: 600 });
        return;
      }
      if (request.method === 'GET' && path === '/demo/flaky') {
        const step = flakyCount++ % 4;
        return send(step === 1 || step === 2 ? 503 : 200, { demo: true, sequence_step: step + 1, pattern: [200, 503, 503, 200] });
      }
      if (request.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(join(root, 'public', file));
        response.writeHead(200, { 'Content-Type': type });
        response.end(content); return;
      }
      send(404, { error: 'Route not found' });
    } catch (error) {
      if (!response.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Internal error' });
      if (!error.status) console.error(error);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server, store, runner,
    async listen(port = 4312) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      if (scheduling) runner.start();
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      await runner.stop();
      await new Promise(resolve => server.close(resolve));
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbPath = process.env.PULSEWATCH_DB || join(root, 'data', 'pulsewatch.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const port = Number(process.env.PORT || 4312);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  const app = createApp({ dbPath });
  try { console.log(`PulseWatch is running at ${await app.listen(port)}`); }
  catch (error) { app.store.close(); console.error(`Could not start: ${error.message}`); process.exitCode = 1; }
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    await app.close();
  });
}
