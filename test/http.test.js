import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startApp, shiftDoc, doubleDoc } from './helpers.js';

const TIPS = '00000000-0000-4000-8000-000000000001'; // the built-in Tips income type

async function withApp(fn, opts) {
  const app = await startApp(opts);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function seed(app) {
  const venue = (await app.call('POST', '/venues', { name: 'Test Bar' })).body;
  const job = (await app.call('POST', '/jobs', { venue_id: venue.id, title: 'Bartender' })).body;
  return { venue, job };
}

test('catalog CRUD: venue, job, wage rates, archive-when-referenced', () =>
  withApp(async (app) => {
    const { venue, job } = await seed(app);
    assert.equal((await app.call('POST', '/venues', { name: '' })).status, 400);
    assert.equal((await app.call('POST', '/jobs', { venue_id: app.newId(), title: 'X' })).status, 400);

    const rate = await app.call('POST', '/wage-rates', { effective_from: '2026-01-01', rate_cents: 1125, note: 'bump' });
    assert.equal(rate.status, 201);
    const dupe = await app.call('POST', '/wage-rates', { effective_from: '2026-01-01', rate_cents: 1200 });
    assert.equal(dupe.status, 409);
    assert.match(dupe.body.problems[0], /already a rate from 2026-01-01/);
    assert.equal((await app.call('POST', '/wage-rates', { job_id: job.id, effective_from: '2026-02-01', rate_cents: 1200 })).status, 400, 'a rate belongs to no job');
    assert.equal((await app.call('PATCH', `/wage-rates/${rate.body.id}`, { rate_cents: 1200 })).body.rate_cents, 1200);
    const later = (await app.call('POST', '/wage-rates', { effective_from: '2026-06-01', rate_cents: 1300 })).body;
    assert.equal((await app.call('PATCH', `/wage-rates/${later.id}`, { effective_from: '2026-01-01' })).status, 409, 'moving a rate onto a taken date');
    assert.equal((await app.call('PATCH', `/wage-rates/${later.id}`, { effective_from: '2026-07-01' })).body.effective_from, '2026-07-01');
    assert.deepEqual((await app.call('GET', '/wage-rates')).body.wage_rates.map((r) => [r.effective_from, r.rate_cents]), [['2026-01-01', 1200], ['2026-07-01', 1300]], 'oldest first');
    assert.equal((await app.call('DELETE', `/wage-rates/${rate.body.id}`)).status, 204);

    const patched = await app.call('PATCH', `/venues/${venue.id}`, { notes: 'downtown' });
    assert.equal(patched.body.notes, 'downtown');

    await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(job.id));
    const del = await app.call('DELETE', `/jobs/${job.id}`);
    assert.deepEqual(del.body, { archived: true });
    assert.equal((await app.call('GET', '/jobs')).body.jobs.length, 0);
    assert.equal((await app.call('GET', '/jobs?include_archived=1')).body.jobs.length, 1);

    const lone = (await app.call('POST', '/venues', { name: 'Unused' })).body;
    assert.deepEqual((await app.call('DELETE', `/venues/${lone.id}`)).body, { archived: false });
    assert.equal((await app.call('GET', `/venues/${lone.id}`)).status, 404);
  }));

test('shift lifecycle over HTTP: PUT twice, list, patch, soft and hard delete', () =>
  withApp(async (app) => {
    const { job } = await seed(app);
    const location = (await app.call('POST', '/locations', { name: 'Main Bar' })).body;
    const ana = (await app.call('POST', '/employees', { name: 'Ana' })).body;
    const ben = (await app.call('POST', '/employees', { name: 'Ben', role: 'Barback' })).body;
    const id = app.newId();
    const doc = doubleDoc(job.id, {
      location_id: location.id, tags: ['busy'],
      employees: [{ employee_id: ben.id, start_at: '2026-09-18T12:00', end_at: '2026-09-18T20:00', tips_cents: 9000 }, { employee_id: ana.id }],
      parties: [{ name: 'Smith 40th', guests: 40 }],
      breaks: [{ start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }, { minutes: 10 }],
      money_entries: [{ value_cents: 21000, part: 'day' }, { value_cents: 34550, part: 'night' }, { value_cents: 1000, part: null }],
    });
    const first = await app.call('PUT', `/shifts/${id}`, doc);
    assert.equal(first.status, 201);
    assert.equal(first.body.work_date, '2026-09-18');
    assert.equal(first.body.shift_type, 'double');
    assert.deepEqual(first.body.breaks, [{ start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }, { minutes: 10 }]);
    assert.equal(first.body.location_id, location.id);
    assert.deepEqual(first.body.employees, [
      { employee_id: ana.id, start_at: null, end_at: null, tips_cents: null },
      { employee_id: ben.id, start_at: '2026-09-18T12:00', end_at: '2026-09-18T20:00', tips_cents: 9000 },
    ], 'staff come back by name, with their times and tips');
    assert.deepEqual(first.body.parties, [{ name: 'Smith 40th', guests: 40, start_at: null, end_at: null, notes: null }]);
    assert.deepEqual([first.body.derived.has_party, first.body.derived.party_count], [true, 1]);
    assert.deepEqual(first.body.money_entries.map((m) => [m.category_id, m.value_cents, m.part]),
      [[TIPS, 21000, 'day'], [TIPS, 34550, 'night'], [TIPS, 1000, null]], 'an entry with no type is tips');
    assert.equal((await app.call('PUT', `/shifts/${id}`, doc)).status, 200);

    const list = await app.call('GET', '/shifts?from=2026-09-01&to=2026-09-30');
    assert.equal(list.body.shifts.length, 1);
    assert.equal((await app.call('GET', '/shifts?from=2026-10-01')).body.shifts.length, 0);
    assert.equal((await app.call('GET', `/shifts?location_id=${location.id}`)).body.shifts.length, 1);
    assert.equal((await app.call('GET', `/shifts?location_id=${app.newId()}`)).body.shifts.length, 0);
    assert.equal((await app.call('GET', '/shifts?location_id=nope')).status, 400);
    assert.equal((await app.call('GET', `/shifts?employee_id=${ben.id}`)).body.shifts.length, 1, 'shifts a person worked');
    assert.equal((await app.call('GET', `/shifts?employee_id=${app.newId()}`)).body.shifts.length, 0);
    assert.equal((await app.call('GET', '/shifts?employee_id=nope')).status, 400);
    assert.equal((await app.call('GET', '/shifts?has_party=1')).body.shifts.length, 1, 'shifts with a party');
    assert.equal((await app.call('GET', '/shifts?has_party=0')).body.shifts.length, 0, 'and without');
    assert.equal((await app.call('GET', '/shifts?has_party=yes')).status, 400);

    const patched = await app.call('PATCH', `/shifts/${id}`, { notes: 'late close', breaks: [{ minutes: 45 }], employees: [{ employee_id: ana.id }], parties: [] });
    assert.deepEqual([patched.body.notes, patched.body.breaks, patched.body.employees.map((e) => e.employee_id), patched.body.parties], ['late close', [{ minutes: 45 }], [ana.id], []]);
    assert.equal((await app.call('GET', '/shifts?has_party=0')).body.shifts.length, 1, 'the flag follows the parties');
    assert.equal(patched.body.money_entries.length, 3);
    const badPatch = await app.call('PATCH', `/shifts/${id}`, { end_at: '2026-09-18T10:00' });
    assert.equal(badPatch.status, 400);
    assert.match(badPatch.body.problems.join(), /after start_at/);

    const money = await app.call('POST', `/shifts/${id}/money`, { value_cents: 4000, part: 'night' });
    assert.equal(money.status, 201);
    assert.equal(money.body.category_id, TIPS);
    assert.equal((await app.call('PATCH', `/money/${money.body.id}`, { value_cents: 4500 })).body.value_cents, 4500);
    assert.equal((await app.call('PATCH', `/money/${money.body.id}`, { part: null })).body.part, null);
    assert.equal((await app.call('POST', `/shifts/${id}/money`, { value_cents: 1, category: 'wage' })).status, 400, 'the old name field is gone');
    const noType = await app.call('POST', `/shifts/${id}/money`, { value_cents: 1, category_id: app.newId() });
    assert.equal(noType.status, 400);
    assert.match(noType.body.problems.join(), /no such income type/);
    assert.equal((await app.call('DELETE', `/money/${money.body.id}`)).status, 204);
    assert.equal((await app.call('GET', `/shifts/${id}`)).body.money_entries.length, 3);

    assert.equal((await app.call('DELETE', `/shifts/${id}`)).status, 204);
    assert.equal((await app.call('GET', '/shifts')).body.shifts.length, 0);
    assert.ok((await app.call('GET', `/shifts/${id}`)).body.deleted_at);
    const dump = (await app.call('GET', '/export')).body;
    assert.deepEqual([dump.shifts.length, dump.locations.length, dump.employees.length], [1, 1, 2]);
    assert.equal((await app.call('DELETE', `/shifts/${id}?hard=1`)).status, 204);
    assert.equal((await app.call('GET', `/shifts/${id}`)).status, 404);
    assert.equal((await app.call('GET', '/export')).body.shifts.length, 0);
  }));

test('a shift needs a type; tip periods, timezones and zoned times are gone', () =>
  withApp(async (app) => {
    const { job } = await seed(app);
    const noType = shiftDoc(job.id);
    delete noType.shift_type;
    const missing = await app.call('PUT', `/shifts/${app.newId()}`, noType);
    assert.equal(missing.status, 400);
    assert.match(missing.body.problems.join(), /shift_type: required/);
    const old = await app.call('PUT', `/shifts/${app.newId()}`, { ...shiftDoc(job.id), tz: 'America/New_York', tip_periods: [], start_at: '2026-09-18T21:00:00Z' });
    assert.equal(old.status, 400);
    assert.match(old.body.problems.join(), /tz: unknown field/);
    assert.match(old.body.problems.join(), /tip_periods: unknown field/);
    assert.match(old.body.problems.join(), /start_at: must be a local time/);
    const wrongPart = await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(job.id, { money_entries: [{ value_cents: 5, part: 'day' }] }));
    assert.match(wrongPart.body.problems.join(), /this is a night shift/);
    const badBreak = await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(job.id, { breaks: [{ start_at: '2026-09-18T20:00', end_at: '2026-09-18T20:30', minutes: 30 }] }));
    assert.match(badBreak.body.problems.join(), /a start and end or a length in minutes, not both/);
    const noPlace = await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(job.id, { location_id: app.newId() }));
    assert.match(noPlace.body.problems.join(), /location_id: no such location/);
    const noPerson = await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(job.id, { employees: [{ employee_id: app.newId() }] }));
    assert.match(noPerson.body.problems.join(), /employees: no such employee/);
    assert.equal((await app.call('GET', '/shifts')).body.shifts.length, 0, 'nothing was saved');
    const jobless = await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(undefined));
    assert.equal(jobless.status, 201, 'a shift needs no job or location');
    assert.deepEqual([jobless.body.job_id, jobless.body.location_id], [null, null]);
  }));

test('pagination over HTTP and query validation', () =>
  withApp(async (app) => {
    const { job } = await seed(app);
    for (let day = 10; day < 13; day++) {
      await app.call('PUT', `/shifts/${app.newId()}`, shiftDoc(job.id, { start_at: `2026-09-${day}T17:00`, end_at: `2026-09-${day}T23:00` }));
    }
    const p1 = await app.call('GET', '/shifts?limit=2');
    assert.equal(p1.body.shifts.length, 2);
    assert.ok(p1.body.next_cursor);
    const p2 = await app.call('GET', `/shifts?limit=2&cursor=${p1.body.next_cursor}`);
    assert.equal(p2.body.shifts.length, 1);
    assert.equal(p2.body.next_cursor, null);
    assert.equal((await app.call('GET', '/shifts?limit=0')).status, 400);
    assert.equal((await app.call('GET', '/shifts?from=yesterday')).status, 400);
  }));

test('error handling: bad JSON, unknown route, wrong method, bad id, validation shape', () =>
  withApp(async (app) => {
    const { job } = await seed(app);
    assert.equal((await app.call('POST', '/venues', '{not json')).status, 400);
    assert.equal((await app.call('GET', '/nope')).status, 404);
    assert.equal((await app.call('POST', '/health', {})).status, 405);
    assert.equal((await app.call('PUT', '/shifts/not-a-uuid', shiftDoc(job.id))).status, 400);
    assert.equal((await app.call('GET', `/shifts/${app.newId()}`)).status, 404);
    const res = await app.call('PUT', `/shifts/${app.newId()}`, { ...shiftDoc(job.id), start_at: '2026-09-18T17:00Z', hours: 8 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'VALIDATION');
    assert.ok(res.body.problems.length >= 2);
  }));

test('with API_TOKEN: 401 without or with a wrong token, 200 with it, health stays open', () =>
  withApp(async (app) => {
    assert.equal((await app.call('GET', '/venues')).status, 401);
    assert.equal((await app.call('GET', '/venues', undefined, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await app.call('GET', '/venues', undefined, { authorization: 'Bearer s3cret' })).status, 200);
    assert.equal((await app.call('GET', '/health')).status, 200);
  }, { token: 's3cret' }));

test('refuses to listen on a non-loopback host without API_TOKEN', () => {
  const entry = fileURLToPath(new URL('../server/index.js', import.meta.url));
  const env = { ...process.env, HOST: '0.0.0.0', PORT: '0', DB_PATH: ':memory:' };
  delete env.API_TOKEN;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to listen/);
});
