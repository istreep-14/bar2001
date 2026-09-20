import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { createBus, createExternalWatch } from '../server/events.js';
import { startApp, openEvents, shiftDoc, doubleDoc } from './helpers.js';

async function withApp(fn, opts) {
  const app = await startApp(opts);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test('bus: increasing seq, ring buffer cap, unsubscribe', () => {
  const bus = createBus({ keep: 3 });
  const seen = [];
  const off = bus.subscribe((e) => seen.push(e.seq));
  for (let i = 0; i < 5; i++) bus.emit({ entity: 'shift', op: 'created', id: String(i) });
  off();
  bus.emit({ entity: 'shift', op: 'created', id: 'x' });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.deepEqual(bus.recent().map((e) => e.seq), [4, 5, 6]);
  assert.ok(bus.recent()[0].at);
});

test('SSE: hello, then a change event for every kind of write, with the shift attached', () =>
  withApp(async (app) => {
    const venue = (await app.call('POST', '/venues', { name: 'Test Bar' })).body;
    const job = (await app.call('POST', '/jobs', { venue_id: venue.id, title: 'Bartender' })).body;

    const feed = await openEvents(app.base);
    assert.equal(feed.status, 200);
    const hello = await feed.next();
    assert.equal(hello.event, 'hello');
    assert.equal(hello.data.instance, app.bus.instance);
    assert.deepEqual(hello.data.recent.map((e) => `${e.entity}.${e.op}`), ['venue.created', 'job.created']);

    const place = (await app.call('POST', '/locations', { name: 'Main' })).body;
    let e = (await feed.next()).data;
    assert.deepEqual([e.entity, e.op, e.id, e.label, e.data.name], ['location', 'created', place.id, 'Main', 'Main']);
    const ana = (await app.call('POST', '/employees', { name: 'Ana', role: 'Bartender' })).body;
    e = (await feed.next()).data;
    assert.deepEqual([e.entity, e.op, ana.name, e.data.role], ['employee', 'created', 'Ana', 'Bartender']);
    await app.call('POST', '/employees', { name: 'ANA' }); // already there: adding again announces nothing
    await app.call('PATCH', `/employees/${ana.id}`, { name: 'Anna', notes: 'closes on Fridays' });
    e = (await feed.next()).data;
    assert.deepEqual([e.entity, e.op, e.label, e.data.notes], ['employee', 'updated', 'Anna', 'closes on Fridays']);

    const id = app.newId();
    await app.call('PUT', `/shifts/${id}`, shiftDoc(job.id, { location_id: place.id, employees: [{ employee_id: ana.id }], parties: [{}], money_entries: [{ value_cents: 21000 }] }));
    e = (await feed.next()).data;
    assert.deepEqual([e.entity, e.op, e.id, e.label], ['shift', 'created', id, '2026-09-18 · Main']);
    assert.equal(e.data.money_entries[0].value_cents, 21000);
    assert.equal(e.data.shift_type, 'night');
    assert.deepEqual([e.data.employees.map((x) => x.employee_id), e.data.derived.has_party], [[ana.id], true]);

    await app.call('PUT', `/shifts/${id}`, shiftDoc(job.id, { notes: 'again' }));
    e = (await feed.next()).data;
    assert.deepEqual([e.op, e.data.notes], ['updated', 'again']);

    await app.call('PATCH', `/shifts/${id}`, { notes: 'late close' });
    assert.equal((await feed.next()).data.data.notes, 'late close');

    const money = (await app.call('POST', `/shifts/${id}/money`, { value_cents: 6000 })).body;
    e = (await feed.next()).data;
    assert.equal(e.note, 'money added: Tips $60.00 (night)');
    assert.equal(e.data.money_entries.length, 1);
    await app.call('PATCH', `/money/${money.id}`, { value_cents: 7000, part: null });
    assert.equal((await feed.next()).data.note, 'money changed: Tips $70.00 (night)'); // one period: "combined" attaches to it
    await app.call('DELETE', `/money/${money.id}`);
    e = (await feed.next()).data;
    assert.equal(e.note, 'money removed: Tips $70.00 (night)');
    assert.equal(e.data.money_entries.length, 0);

    await app.call('DELETE', `/shifts/${id}`);
    e = (await feed.next()).data;
    assert.deepEqual([e.op, !!e.data.deleted_at], ['deleted', true]);
    await app.call('DELETE', `/shifts/${id}`); // already deleted: no event
    await app.call('DELETE', `/shifts/${id}?hard=1`);
    e = (await feed.next()).data;
    assert.deepEqual([e.op, e.id, e.data], ['purged', id, undefined]);
    assert.deepEqual((await app.call('DELETE', `/locations/${place.id}`)).body, { archived: false }, 'nothing refers to it any more');
    e = (await feed.next()).data;
    assert.deepEqual([e.entity, e.op, e.id, e.data], ['location', 'deleted', place.id, undefined]);

    const seqs = app.bus.recent().map((x) => x.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    feed.close();
  }));

test('SSE: a new connection replays recent activity, and failed writes emit nothing', () =>
  withApp(async (app) => {
    const venue = (await app.call('POST', '/venues', { name: 'Test Bar' })).body;
    const job = (await app.call('POST', '/jobs', { venue_id: venue.id, title: 'Bartender' })).body;
    const before = app.bus.recent().length;
    await app.call('PUT', `/shifts/${app.newId()}`, { ...shiftDoc(job.id), start_at: '2026-09-18T17:00Z' }); // 400
    await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(app.newId())); // unknown job -> 400
    await app.call('POST', '/venues', { name: '' }); // 400
    assert.equal(app.bus.recent().length, before);
    const feed = await openEvents(app.base);
    assert.equal((await feed.next()).data.recent.length, before);
    feed.close();
  }));

test('catalog changes are announced, including archive instead of delete', () =>
  withApp(async (app) => {
    const feed = await openEvents(app.base);
    await feed.next();
    const venue = (await app.call('POST', '/venues', { name: 'Test Bar' })).body;
    assert.deepEqual([(await feed.next()).data.entity, venue.name], ['venue', 'Test Bar']);
    const job = (await app.call('POST', '/jobs', { venue_id: venue.id, title: 'Bartender' })).body;
    assert.equal((await feed.next()).data.entity, 'job');
    const rate = (await app.call('POST', '/wage-rates', { effective_from: '2026-01-01', rate_cents: 1125 })).body;
    const created = (await feed.next()).data;
    assert.deepEqual([created.entity, created.label], ['wage_rate', '2026-01-01 · $11.25/hr']);
    await app.call('DELETE', `/wage-rates/${rate.id}`);
    assert.equal((await feed.next()).data.op, 'deleted');
    await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(job.id));
    await feed.next();
    await app.call('DELETE', `/jobs/${job.id}`);
    const archived = (await feed.next()).data;
    assert.deepEqual([archived.entity, archived.op, archived.data.archived], ['job', 'archived', true]);
    feed.close();
  }));

test('external watch fires for another connection\'s writes, not for its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-watch-'));
  const path = join(dir, 'bar.db');
  const mine = openDb(path);
  const bus = createBus();
  const watch = createExternalWatch(mine, bus);
  assert.equal(watch.check(), false);
  mine.exec("INSERT INTO venues (id, name) VALUES ('a', 'A')");
  assert.equal(watch.check(), false, 'own commits are not external');
  const other = openDb(path);
  other.exec("INSERT INTO venues (id, name) VALUES ('b', 'B')");
  assert.equal(watch.check(), true);
  assert.deepEqual(bus.recent().map((e) => `${e.entity}.${e.op}`), ['db.external']);
  assert.equal(watch.check(), false, 'fires once per change');
  other.close();
  mine.close();
});

test('stats: raw counts and server clock', () =>
  withApp(async (app) => {
    const venue = (await app.call('POST', '/venues', { name: 'Test Bar' })).body;
    const job = (await app.call('POST', '/jobs', { venue_id: venue.id, title: 'Bartender' })).body;
    const a = app.newId();
    await app.call('PUT', `/shifts/${a}`, doubleDoc(job.id, {
      tags: ['busy', 'late'], breaks: [{ minutes: 30 }, { minutes: 15 }],
      money_entries: [{ value_cents: 1, part: 'day' }, { value_cents: 2, part: null }],
    }));
    await app.call('POST', '/locations', { name: 'Main' });
    await app.call('POST', '/employees', { name: 'Ana' });
    await app.call('POST', '/employees', { name: 'Ben' });
    await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(job.id));
    await app.call('DELETE', `/shifts/${a}`);
    const { body } = await app.call('GET', '/stats');
    assert.deepEqual(body.counts, {
      venues: 1, jobs: 1, wage_rates: 0, shifts: 1, shifts_deleted: 1, money_entries: 2, shift_tags: 2, shift_breaks: 2, locations: 1, employees: 2, parties: 0, income_categories: 1,
    });
    assert.equal(body.schema_version, 7);
    assert.ok(Math.abs(Date.parse(body.now) - Date.now()) < 5000);
  }));

test('with API_TOKEN: the event stream is protected but the dashboard page is served', () =>
  withApp(async (app) => {
    assert.equal((await openEvents(app.base)).status, 401);
    const feed = await openEvents(app.base, { authorization: 'Bearer s3cret' });
    assert.equal(feed.status, 200);
    assert.equal((await feed.next()).event, 'hello');
    feed.close();
    const page = await fetch(app.base.replace('/api/v1', '/'));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await page.text(), /Bar2\.000/);
    assert.equal((await app.call('GET', '/stats')).status, 401);
  }, { token: 's3cret' }));

test('dashboard never builds markup from data (user text must stay text)', () => {
  for (const file of ['index.html', 'form.js', 'lists.js', 'employees.js', 'side.js']) {
    const source = readFileSync(new URL(`../dashboard/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
  }
});

test('the page uses no inline styles, since the CSP only allows the stylesheet', () => {
  const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<style[\s>]|\sstyle=/);
  for (const file of ['form.js', 'lists.js', 'employees.js', 'side.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../dashboard/${file}`, import.meta.url), 'utf8'), /\.style\b|['"]style['"]\s*:|setAttribute\(['"]style/, file);
  }
});

test('the browser may load only the whitelisted files (modules, stylesheet, Poppins), without a token', () =>
  withApp(async (app) => {
    const origin = app.base.replace('/api/v1', '');
    for (const [path, needle] of [['/time.js', 'export function resolveEnd'], ['/pay.js', 'export function deriveShift'], ['/form.js', 'export function createShiftForm'], ['/lists.js', 'export function createListsManager'], ['/employees.js', 'export function createEmployeesManager'], ['/side.js', 'export function createSidePanel']]) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /text\/javascript/);
      assert.match(await res.text(), new RegExp(needle));
    }
    const css = await fetch(origin + '/styles.css');
    assert.deepEqual([css.status, css.headers.get('content-type')], [200, 'text/css; charset=utf-8']);
    assert.match(await css.text(), /font-family: "Poppins"/);
    for (const weight of [400, 500, 600, 700]) {
      const font = await fetch(`${origin}/fonts/poppins-${weight}.woff2`);
      assert.deepEqual([font.status, font.headers.get('content-type')], [200, 'font/woff2'], `poppins ${weight}`);
      assert.match(font.headers.get('cache-control'), /immutable/);
      assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2', 'a real woff2 file');
    }
    for (const path of ['/fonts/poppins-300.woff2', '/fonts/OFL.txt', '/dashboard/styles.css', '/fonts/', '/toString', '/__proto__']) {
      assert.equal((await fetch(origin + path)).status, 404, path);
    }
    for (const path of ['/server/db.js', '/dashboard/form.js', '/package.json', '/../package.json', '/%2e%2e/package.json', '/data/bar.db', '/migrations/001_init.sql']) {
      assert.equal((await fetch(origin + path)).status, 404, path);
    }
    const csp = (await fetch(origin + '/')).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'(;|$)/, 'no inline styles, no third-party styles');
    assert.match(csp, /font-src 'self'/);
  }, { token: 's3cret' }));
