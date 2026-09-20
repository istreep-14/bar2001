import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { createRouter, HttpError, Reply } from './http.js';
import { isAuthorized, isLoopback } from './auth.js';
import { registerCatalog } from './routes/catalog.js';
import { registerLists } from './routes/lists.js';
import { registerEmployees } from './routes/employees.js';
import { registerShifts } from './routes/shifts.js';
import { registerExport } from './routes/export.js';
import { registerStats } from './routes/stats.js';
import { createBus, createExternalWatch } from './events.js';

const MAX_BODY_BYTES = 1024 * 1024;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The only files the browser may load besides the page. time.js and pay.js are the server's own time and
// wage math, shared so the form converts times, and estimates wages, exactly as the server does. The font files
// are served from here too (no request ever goes to a third party), and cached because they never change.
const JS = 'text/javascript; charset=utf-8';
const FONT = 'font/woff2';
const BROWSER_FILES = {
  '/time.js': { file: join(ROOT, 'server', 'time.js'), type: JS },
  '/pay.js': { file: join(ROOT, 'server', 'pay.js'), type: JS },
  '/form.js': { file: join(ROOT, 'dashboard', 'form.js'), type: JS },
  '/lists.js': { file: join(ROOT, 'dashboard', 'lists.js'), type: JS },
  '/employees.js': { file: join(ROOT, 'dashboard', 'employees.js'), type: JS },
  '/side.js': { file: join(ROOT, 'dashboard', 'side.js'), type: JS },
  '/styles.css': { file: join(ROOT, 'dashboard', 'styles.css'), type: 'text/css; charset=utf-8' },
  ...Object.fromEntries([400, 500, 600, 700].map((w) => [`/fonts/poppins-${w}.woff2`, { file: join(ROOT, 'dashboard', 'fonts', `poppins-${w}.woff2`), type: FONT, immutable: true }])),
};

export function createApp({ db, token = null, bus = createBus() }) {
  const router = createRouter();
  router.add('GET', '/api/v1/health', () => ({ ok: true }));
  registerCatalog(router, db, bus);
  registerLists(router, db, bus);
  registerEmployees(router, db, bus);
  registerShifts(router, db, bus);
  registerExport(router, db);
  registerStats(router, db);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return sendDashboard(res);
      if (req.method === 'GET' && Object.hasOwn(BROWSER_FILES, pathname)) return sendBrowserFile(res, BROWSER_FILES[pathname]);
      if (pathname === '/favicon.ico') return void res.writeHead(204).end();
      if (!pathname.startsWith('/api/v1')) throw new HttpError(404, 'NOT_FOUND', ['not found']);
      if (pathname !== '/api/v1/health' && !isAuthorized(req, token)) {
        throw new HttpError(401, 'UNAUTHORIZED', ['missing or wrong bearer token']);
      }
      if (req.method === 'GET' && pathname === '/api/v1/events') return streamEvents(req, res, bus);

      const { handler, params, pathMatched } = router.match(req.method, pathname);
      if (!handler) {
        throw pathMatched
          ? new HttpError(405, 'METHOD_NOT_ALLOWED', [`${req.method} not allowed here`])
          : new HttpError(404, 'NOT_FOUND', ['not found']);
      }

      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : null;
      const result = handler({ params, query: url.searchParams, body });
      send(res, result);
    } catch (err) {
      sendError(res, err);
    }
  });
  server.bus = bus;
  return server;
}

function sendBrowserFile(res, { file, type, immutable = false }) {
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=604800, immutable' : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(readFileSync(file));
}

// The page holds no data itself: it fetches everything from the API with the bearer
// token (if any) that the viewer types in, so serving it needs no auth.
function sendDashboard(res) {
  const html = readFileSync(join(ROOT, 'dashboard', 'index.html'));
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(html);
}

// Server-Sent Events. `hello` carries recent activity; every later change is a `change` event.
function streamEvents(req, res, bus) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const write = (event, data, id) => res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write('retry: 2000\n\n');
  write('hello', { instance: bus.instance, recent: bus.recent() });
  const unsubscribe = bus.subscribe((e) => write('change', e, e.seq));
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'TOO_LARGE', ['request body too large']);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'BAD_JSON', ['request body is not valid JSON']);
  }
}

function send(res, result) {
  if (result === undefined) {
    res.writeHead(204).end();
    return;
  }
  const { status, body } = result instanceof Reply ? result : { status: 200, body: result };
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  let status = 500;
  let payload = { error: 'INTERNAL', problems: [] };
  if (err instanceof HttpError) {
    status = err.status;
    payload = { error: err.code, problems: err.problems };
  } else if (err instanceof URIError) {
    status = 400;
    payload = { error: 'BAD_REQUEST', problems: ['malformed URL'] };
  } else if (/UNIQUE constraint failed|FOREIGN KEY constraint failed/.test(err?.message ?? '')) {
    status = 409;
    payload = { error: 'CONFLICT', problems: [String(err.message)] };
  } else {
    console.error(err);
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function main() {
  const port = Number(process.env.PORT ?? 4200);
  const host = process.env.HOST ?? '127.0.0.1';
  const token = process.env.API_TOKEN || null;
  const dbPath = process.env.DB_PATH ?? join(ROOT, 'data', 'bar.db');

  if (!isLoopback(host) && !token) {
    console.error(`Refusing to listen on ${host} without API_TOKEN. Set API_TOKEN, or use HOST=127.0.0.1.`);
    process.exit(1);
  }

  const db = openDb(dbPath);
  const server = createApp({ db, token });
  const watch = createExternalWatch(db, server.bus);
  server.listen(port, host, () => {
    watch.start();
    console.log(`bar2000 listening on http://${host}:${port}  db=${dbPath}  auth=${token ? 'token' : 'off'}`);
  });

  const shutdown = () => {
    watch.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections(); // open dashboards hold SSE streams that would keep close() waiting
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
