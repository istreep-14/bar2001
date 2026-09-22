import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, shiftDoc } from './helpers.js';
import { shiftStore } from '../server/shiftStore.js';

const TIPS = '00000000-0000-4000-8000-000000000001'; // the built-in Tips income type
import { validateShift } from '../server/validate.js';

async function withApp(fn, opts) {
  const app = await startApp(opts);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

// Locations and income types are two lists with the same rules, so every rule is checked on both. (Employees are a
// real table with more to them; they have their own tests below.)
// `ref` builds a shift document that uses an entry; `uses` says whether a stored shift points at it.
const LISTS = [
  { path: 'locations', key: 'locations', builtIn: 0, ref: (id) => ({ location_id: id }), uses: (s, id) => s.location_id === id },
  {
    path: 'income-categories', key: 'income_categories', builtIn: 1, // Tips
    ref: (id) => ({ money_entries: [{ value_cents: 500, category_id: id }] }), uses: (s, id) => s.money_entries.some((m) => m.category_id === id),
  },
];

for (const { path, key, builtIn, ref, uses } of LISTS) {
  const mine = async (app, query = '') => (await app.call('GET', `/${path}${query}`)).body[key].filter((x) => !x.system);

  test(`/${path}: adding is find-or-create by name, ignoring case and spacing`, () =>
    withApp(async (app) => {
      const first = await app.call('POST', `/${path}`, { name: '  Main Bar ' });
      assert.equal(first.status, 201);
      assert.deepEqual([first.body.name, first.body.archived], ['Main Bar', false]);
      const again = await app.call('POST', `/${path}`, { name: 'main bar' });
      assert.equal(again.status, 200, 'the same name is not added twice');
      assert.equal(again.body.id, first.body.id);
      assert.equal(again.body.name, 'Main Bar', 'the spelling already on the list wins');
      assert.equal((await mine(app)).length, 1);
      assert.equal((await app.call('POST', `/${path}`, { name: '   ' })).status, 400);
      assert.equal((await app.call('POST', `/${path}`, { name: 'x'.repeat(101) })).status, 400);
      assert.equal((await app.call('POST', `/${path}`, { name: 'A', extra: 1 })).status, 400);
      assert.equal((await app.call('GET', `/${path}/${first.body.id}`)).body.name, 'Main Bar');
      assert.equal((await app.call('GET', `/${path}/${randomUUID()}`)).status, 404);
    }));

  test(`/${path}: the list comes back sorted by name, ignoring case`, () =>
    withApp(async (app) => {
      for (const name of ['cleo', 'Ben', 'ana', 'Dev']) await app.call('POST', `/${path}`, { name });
      const names = (await app.call('GET', `/${path}`)).body[key].map((x) => x.name);
      assert.equal(names.length, 4 + builtIn);
      assert.deepEqual(names.filter((n) => n !== 'Tips'), ['ana', 'Ben', 'cleo', 'Dev']);
    }));

  test(`/${path}: renaming works, and a name that is taken is a plain conflict`, () =>
    withApp(async (app) => {
      const a = (await app.call('POST', `/${path}`, { name: 'Ana' })).body;
      const b = (await app.call('POST', `/${path}`, { name: 'Ben' })).body;
      const renamed = await app.call('PATCH', `/${path}/${a.id}`, { name: 'Anna' });
      assert.equal(renamed.body.name, 'Anna');
      assert.equal((await app.call('PATCH', `/${path}/${a.id}`, { name: 'anna' })).status, 200, 'changing only the case of your own name is fine');
      const clash = await app.call('PATCH', `/${path}/${b.id}`, { name: 'ANNA' });
      assert.equal(clash.status, 409);
      assert.match(clash.body.problems[0], /name: "ANNA" is already in the list/);
      assert.equal((await app.call('GET', `/${path}/${b.id}`)).body.name, 'Ben', 'a refused rename changes nothing');
      assert.equal((await app.call('PATCH', `/${path}/${randomUUID()}`, { name: 'Zed' })).status, 404);
      assert.equal((await app.call('PATCH', `/${path}/${b.id}`, { name: '' })).status, 400);
    }));

  test(`/${path}: removing deletes an unused entry, but archives one a shift uses`, () =>
    withApp(async (app) => {
      const unused = (await app.call('POST', `/${path}`, { name: 'Unused' })).body;
      const used = (await app.call('POST', `/${path}`, { name: 'Used' })).body;
      const shiftId = randomUUID();
      const saved = await app.call('PUT', `/shifts/${shiftId}`, shiftDoc(undefined, ref(used.id)));
      assert.equal(saved.status, 201);

      assert.deepEqual((await app.call('DELETE', `/${path}/${unused.id}`)).body, { archived: false });
      assert.equal((await app.call('GET', `/${path}/${unused.id}`)).status, 404);
      assert.deepEqual((await app.call('DELETE', `/${path}/${used.id}`)).body, { archived: true });

      assert.equal((await mine(app)).length, 0, 'archived entries are not offered');
      assert.deepEqual((await mine(app, '?include_archived=1')).map((x) => [x.name, x.archived]), [['Used', true]], 'but they still resolve, so history keeps its names');
      assert.ok(uses((await app.call('GET', `/shifts/${shiftId}`)).body, used.id), 'the shift still points at it');

      const back = await app.call('POST', `/${path}`, { name: 'used' });
      assert.deepEqual([back.status, back.body.id, back.body.archived], [200, used.id, false], 'adding the name again brings the same entry back');

      // once no shift uses it, removing really deletes it
      await app.call('DELETE', `/shifts/${shiftId}?hard=1`);
      assert.deepEqual((await app.call('DELETE', `/${path}/${used.id}`)).body, { archived: false });
    }));
}

test('Tips is built in: it can be found and used, but not renamed, archived or removed', () =>
  withApp(async (app) => {
    const all = (await app.call('GET', '/income-categories')).body.income_categories;
    assert.deepEqual(all.map((c) => [c.id, c.name, c.system]), [[TIPS, 'Tips', true]]);
    assert.deepEqual([(await app.call('POST', '/income-categories', { name: 'TIPS' })).status, (await app.call('POST', '/income-categories', { name: 'tips' })).body.id], [200, TIPS]);
    for (const [method, body] of [['PATCH', { name: 'Gratuity' }], ['PATCH', { archived: true }], ['DELETE', undefined]]) {
      const r = await app.call(method, `/income-categories/${TIPS}`, body);
      assert.equal(r.status, 409, `${method} ${JSON.stringify(body)}`);
      assert.match(r.body.problems[0], /“Tips” is built in/);
    }
    assert.equal((await app.call('POST', '/income-categories', { name: 'Cash' })).body.system, false);
  }));

test('a shift can mix income types: an entry with no type is tips, each type reads back, and a purge frees the type', () =>
  withApp(async (app) => {
    const cash = (await app.call('POST', '/income-categories', { name: 'Cash' })).body;
    const venmo = (await app.call('POST', '/income-categories', { name: 'Venmo' })).body;
    const id = randomUUID();
    const put = await app.call('PUT', `/shifts/${id}`, shiftDoc(undefined, {
      money_entries: [{ value_cents: 10000 }, { value_cents: 2500, category_id: cash.id }, { value_cents: 4000, category_id: venmo.id }, { value_cents: 500, category_id: cash.id }],
    }));
    assert.equal(put.status, 201);
    assert.deepEqual(put.body.money_entries.map((m) => [m.category_id, m.value_cents]),
      [[TIPS, 10000], [cash.id, 2500], [venmo.id, 4000], [cash.id, 500]], 'they keep their order');
    const added = await app.call('POST', `/shifts/${id}/money`, { value_cents: 900, category_id: venmo.id });
    assert.equal(added.body.category_id, venmo.id);
    assert.equal((await app.call('PATCH', `/money/${added.body.id}`, { category_id: cash.id })).body.category_id, cash.id, 'an entry can change type');
    assert.equal((await app.call('PATCH', `/money/${added.body.id}`, { category_id: randomUUID() })).status, 400);
    const noSuch = await app.call('PUT', `/shifts/${randomUUID()}`, shiftDoc(undefined, { money_entries: [{ value_cents: 1, category_id: randomUUID() }] }));
    assert.match(noSuch.body.problems.join(), /no such income type/);
    const patched = await app.call('PATCH', `/shifts/${id}`, { notes: 'x' });
    assert.equal(patched.body.money_entries.length, 5, 'a patch that leaves income out keeps it, types and all');
    await app.call('DELETE', `/shifts/${id}?hard=1`);
    assert.deepEqual((await app.call('DELETE', `/income-categories/${venmo.id}`)).body, { archived: false });
  }));

// ---- employees -------------------------------------------------------------------------
test('/employees: adding is find-or-create by name, and carries roles/first/last/id_number/manager/is_me/notes for a new person only', () =>
  withApp(async (app) => {
    const first = await app.call('POST', '/employees', {
      name: '  Ana ', first: 'Ana', last: 'Lee', id_number: '042', roles: ['Bartender'], manager: true, is_me: true, notes: 'closes Fridays',
    });
    assert.equal(first.status, 201);
    assert.deepEqual(
      [first.body.name, first.body.roles, first.body.manager, first.body.is_me, first.body.notes, first.body.archived],
      ['Ana', ['Bartender'], true, true, 'closes Fridays', false],
    );
    const again = await app.call('POST', '/employees', { name: 'ana', roles: ['Barback'] });
    assert.deepEqual([again.status, again.body.id, again.body.roles], [200, first.body.id, ['Bartender']], 'the person already there is returned as they are');
    const bare = (await app.call('POST', '/employees', { name: 'Ben' })).body;
    assert.deepEqual([bare.roles, bare.manager, bare.is_me, bare.notes], [[], false, false, null], 'roles and the flags are optional');
    assert.equal((await app.call('POST', '/employees', { name: '' })).status, 400);
    assert.equal((await app.call('POST', '/employees', { name: 'Cleo', phone: '555' })).status, 400, 'no such field yet');
    assert.equal((await app.call('POST', '/employees', { name: 'Cleo', archived: true })).body.archived, false, 'a new person is never created archived');
    assert.equal((await app.call('POST', '/employees', { name: 'Deb', is_me: true })).status, 409, 'only one employee can be flagged as you');
    assert.deepEqual((await app.call('GET', '/employees')).body.employees.map((e) => e.name), ['Ana', 'Ben', 'Cleo'], 'sorted by name');
    assert.equal((await app.call('GET', `/employees/${first.body.id}`)).body.notes, 'closes Fridays');
    assert.equal((await app.call('GET', `/employees/${randomUUID()}`)).status, 404);
  }));

test('/employees: name, roles and notes can each be changed or cleared, and a name that is taken is a plain conflict', () =>
  withApp(async (app) => {
    const ana = (await app.call('POST', '/employees', { name: 'Ana', roles: ['Bartender'], notes: 'x' })).body;
    const ben = (await app.call('POST', '/employees', { name: 'Ben' })).body;
    const patched = await app.call('PATCH', `/employees/${ana.id}`, { roles: ['Barback', 'Bartender'] });
    assert.deepEqual([patched.body.name, patched.body.roles, patched.body.notes], ['Ana', ['Barback', 'Bartender'], 'x'], 'only what was sent changes');
    assert.deepEqual([(await app.call('PATCH', `/employees/${ana.id}`, { roles: [], notes: '' })).body].map((e) => [e.roles, e.notes])[0], [[], null], 'clearing a field');
    assert.equal((await app.call('PATCH', `/employees/${ana.id}`, { name: 'anna' })).body.name, 'anna');
    const clash = await app.call('PATCH', `/employees/${ben.id}`, { name: 'ANNA' });
    assert.equal(clash.status, 409);
    assert.match(clash.body.problems[0], /"ANNA" is already on your employees list/);
    assert.equal((await app.call('PATCH', `/employees/${ben.id}`, { name: 'Ben' })).status, 200, 'keeping your own name is fine');
    assert.equal((await app.call('PATCH', `/employees/${randomUUID()}`, { roles: ['x'] })).status, 404);
    assert.equal((await app.call('PATCH', `/employees/${ben.id}`, { name: '' })).status, 400);
    assert.equal((await app.call('PATCH', `/employees/${ben.id}`, { shoe_size: 9 })).status, 400);
    assert.equal((await app.call('PATCH', `/employees/${ben.id}`, { is_me: true })).status, 200);
    assert.equal((await app.call('PATCH', `/employees/${ana.id}`, { is_me: true })).status, 409, 'Ben already is you');
  }));

test('/employees: removing deletes someone who never worked a shift, but archives someone who did', () =>
  withApp(async (app) => {
    const unused = (await app.call('POST', '/employees', { name: 'Unused' })).body;
    const used = (await app.call('POST', '/employees', { name: 'Used', roles: ['Server'] })).body;
    const shiftId = randomUUID();
    await app.call('PUT', `/shifts/${shiftId}`, shiftDoc(undefined, { employees: [{ employee_id: used.id, tips_cents: 500 }] }));
    assert.deepEqual((await app.call('DELETE', `/employees/${unused.id}`)).body, { archived: false });
    assert.equal((await app.call('GET', `/employees/${unused.id}`)).status, 404);
    assert.deepEqual((await app.call('DELETE', `/employees/${used.id}`)).body, { archived: true });
    assert.equal((await app.call('GET', '/employees')).body.employees.length, 0, 'archived people are not offered');
    const all = (await app.call('GET', '/employees?include_archived=1')).body.employees;
    assert.deepEqual(all.map((e) => [e.name, e.roles, e.archived]), [['Used', ['Server'], true]], 'but they still resolve, roles and all');
    assert.equal((await app.call('GET', `/shifts/${shiftId}`)).body.employees[0].employee_id, used.id, 'the shift still has them');
    const back = await app.call('POST', '/employees', { name: 'used' });
    assert.deepEqual([back.status, back.body.id, back.body.archived, back.body.roles], [200, used.id, false, ['Server']], 'adding the name again brings the same person back');
    await app.call('DELETE', `/shifts/${shiftId}?hard=1`);
    assert.deepEqual((await app.call('DELETE', `/employees/${used.id}`)).body, { archived: false }, 'once no shift has them, they can really go');
  }));

test('/employees/summary: per-person shifts, hours and tips, derived on each read, leaving out deleted shifts and people who never worked', () =>
  withApp(async (app) => {
    const ana = (await app.call('POST', '/employees', { name: 'Ana' })).body;
    const ben = (await app.call('POST', '/employees', { name: 'Ben', roles: ['Barback'] })).body;
    await app.call('POST', '/employees', { name: 'Cleo' });
    const put = (id, date, employees) => app.call('PUT', `/shifts/${id}`, shiftDoc(undefined, {
      start_at: `${date}T17:00`, end_at: `${date}T23:00`, employees,
    }));
    const [a, b, gone] = [randomUUID(), randomUUID(), randomUUID()];
    await put(a, '2026-09-10', [{ employee_id: ana.id, start_at: '2026-09-10T17:00', end_at: '2026-09-11T01:00', tips_cents: 9000 }, { employee_id: ben.id }]);
    await put(b, '2026-09-12', [{ employee_id: ana.id, tips_cents: 500 }]);
    await put(gone, '2026-09-14', [{ employee_id: ana.id, start_at: '2026-09-14T17:00', end_at: '2026-09-14T18:00', tips_cents: 100 }]);
    await app.call('DELETE', `/shifts/${gone}`);
    const { summary } = (await app.call('GET', '/employees/summary')).body;
    const by = Object.fromEntries(summary.map((r) => [r.employee_id, r]));
    assert.deepEqual(by[ana.id], { employee_id: ana.id, shifts: 2, timed_shifts: 1, minutes: 480, tipped_shifts: 2, tips_cents: 9500, first_worked: '2026-09-10', last_worked: '2026-09-12' });
    assert.deepEqual(by[ben.id], { employee_id: ben.id, shifts: 1, timed_shifts: 0, minutes: 0, tipped_shifts: 0, tips_cents: 0, first_worked: '2026-09-10', last_worked: '2026-09-10' });
    assert.equal(summary.length, 2, 'Cleo never worked a shift, so has no row');
    await app.call('PATCH', `/shifts/${b}`, { employees: [] });
    assert.equal((await app.call('GET', '/employees/summary')).body.summary.find((r) => r.employee_id === ana.id).shifts, 1, 'follows the shifts, nothing is stored');
    assert.equal((await app.call('GET', `/employees/${ana.id}`)).status, 200, 'an id still resolves next to /summary');
  }));

test('a soft-deleted shift still holds its employees, so they are archived, not deleted', () =>
  withApp(async (app) => {
    const ana = (await app.call('POST', '/employees', { name: 'Ana' })).body;
    const id = randomUUID();
    await app.call('PUT', `/shifts/${id}`, shiftDoc(undefined, { employees: [{ employee_id: ana.id }] }));
    await app.call('DELETE', `/shifts/${id}`); // soft
    assert.equal((await app.call('DELETE', `/employees/${ana.id}`)).body.archived, true);
  }));

test('staff on a shift read back by name; leaving them out clears them; their tips and hours add to the shift totals', () =>
  withApp(async (app) => {
    const ids = {};
    for (const [name, roles] of [['Cleo', ['Bartender']], ['Ana', []], ['Ben', ['Barback']]]) ids[name] = (await app.call('POST', '/employees', { name, roles })).body.id;
    const id = randomUUID();
    // you: 5pm to 1am (8h paid, $300 tips). Ana 5pm-1am, no tips given. Cleo 6pm-11pm, $100 tips. Ben is a barback: tips count, hours don't.
    const put = await app.call('PUT', `/shifts/${id}`, shiftDoc(undefined, {
      money_entries: [{ value_cents: 30000 }],
      employees: [
        { employee_id: ids.Cleo, start_at: '2026-09-18T18:00', end_at: '2026-09-18T23:00', tips_cents: 10000 },
        { employee_id: ids.Ana, start_at: '2026-09-18T17:00', end_at: '2026-09-19T01:00' },
        { employee_id: ids.Ben, start_at: '2026-09-18T17:00', end_at: '2026-09-19T01:00', tips_cents: 4000 },
      ],
    }));
    assert.deepEqual(put.body.employees.map((e) => e.employee_id), [ids.Ana, ids.Ben, ids.Cleo]);
    const d = put.body.derived;
    assert.deepEqual([d.bartender_count, d.bartender_minutes], [3, 480 + 480 + 300], 'you, Ana (no role) and Cleo; not the barback');
    assert.equal(d.staff_tips_cents, 30000 + 10000 + 4000, 'everyone\'s tips, yours included');
    assert.equal(d.staff_tips_per_bartender_hour_cents, Math.round((44000 * 60) / 1260), '$34.92 per bartender hour');
    // change a role and the totals follow (they are derived on every read)
    await app.call('PATCH', `/employees/${ids.Ana}`, { roles: ['Server'] });
    assert.deepEqual([(await app.call('GET', `/shifts/${id}`)).body.derived.bartender_count, (await app.call('GET', `/shifts/${id}`)).body.derived.bartender_minutes], [2, 480 + 300]);
    assert.equal((await app.call('PUT', `/shifts/${id}`, shiftDoc(undefined))).body.employees.length, 0, 'leaving them out clears them');
    assert.deepEqual((await app.call('GET', `/shifts/${id}`)).body.derived.bartender_count, 1);
  }));

test('shrinking a shift with a patch is refused if a break would fall outside it', () =>
  withApp(async (app) => {
    const id = randomUUID();
    await app.call('PUT', `/shifts/${id}`, shiftDoc(undefined, { breaks: [{ start_at: '2026-09-18T22:00', end_at: '2026-09-18T22:30' }] }));
    const patch = await app.call('PATCH', `/shifts/${id}`, { end_at: '2026-09-18T21:00' });
    assert.equal(patch.status, 400);
    assert.match(patch.body.problems.join(), /the break must fall inside the shift/);
    assert.equal((await app.call('GET', `/shifts/${id}`)).body.end_at, '2026-09-19T01:00', 'nothing changed');
    const moved = await app.call('PATCH', `/shifts/${id}`, { end_at: '2026-09-18T22:30', breaks: [{ start_at: '2026-09-18T20:00', end_at: '2026-09-18T20:15' }] });
    assert.equal(moved.status, 200);
  }));

test('store level: the ids a shift points at are checked before anything is written', () =>
  withApp(async (app) => {
    const store = shiftStore(app.db);
    const doc = validateShift(shiftDoc(undefined, { location_id: randomUUID() })).value;
    assert.throws(() => store.put(randomUUID(), doc), /no such location/);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 0);
  }));
