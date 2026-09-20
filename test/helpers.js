import { randomUUID } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { catalogStore } from '../server/catalog.js';

// In-memory database plus a venue and job, for store-level tests.
export function seedDb() {
  const db = openDb(':memory:');
  const catalog = catalogStore(db);
  const venue = catalog.createVenue({ name: 'Test Bar' });
  const job = catalog.createJob({ venue_id: venue.id, title: 'Bartender' });
  return { db, catalog, venue, job };
}

// A valid shift document: a night shift with no break and no tips yet.
export function shiftDoc(job_id, overrides = {}) {
  return {
    job_id,
    start_at: '2026-09-18T17:00',
    end_at: '2026-09-19T01:00',
    shift_type: 'night',
    ...overrides,
  };
}

// A double: 11:00 AM to 9:30 PM.
export function doubleDoc(job_id, overrides = {}) {
  return shiftDoc(job_id, { start_at: '2026-09-18T11:00', end_at: '2026-09-18T21:30', shift_type: 'double', ...overrides });
}

// A real HTTP server on an ephemeral port, backed by an in-memory database.
export async function startApp({ token = null } = {}) {
  const db = openDb(':memory:');
  const server = createApp({ db, token });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return {
    db,
    base,
    bus: server.bus,
    call,
    newId: randomUUID,
    close: () =>
      new Promise((resolve) => {
        server.close(() => (db.close(), resolve()));
        server.closeAllConnections(); // open SSE streams would otherwise hold close() open
      }),
  };
}

function parseBlock(block) {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  return data ? { event, data: JSON.parse(data) } : null; // comment/keep-alive blocks have no data
}

// Minimal SSE client: `next()` resolves with the next {event, data}, or rejects on timeout.
export async function openEvents(base, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/events', { headers, signal: ctrl.signal });
  if (!res.body || res.status !== 200) return { status: res.status, close: () => ctrl.abort() };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  async function next(ms = 2000) {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const ev = parseBlock(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (ev) return ev;
        continue;
      }
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for an SSE event')), ms);
      });
      try {
        const { value, done } = await Promise.race([reader.read(), timeout]);
        if (done) throw new Error('stream ended');
        buf += value;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return { status: res.status, next, close: () => ctrl.abort() };
}
