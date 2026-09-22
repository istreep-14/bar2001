import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openDb, SCHEMA_VERSION } from '../server/db.js';
import { shiftStore } from '../server/shiftStore.js';
import { validateShift } from '../server/validate.js';
import { seedDb, shiftDoc } from './helpers.js';

// A long shift (11:00 AM to 9:30 PM): used where a test just wants several hours to spread breaks and tips over.
const longDoc = (job_id, overrides = {}) => shiftDoc(job_id, { start_at: '2026-09-18T11:00', end_at: '2026-09-18T21:30', ...overrides });

const TIPS = '00000000-0000-4000-8000-000000000001';

const valid = (doc) => {
  const { value, problems } = validateShift(doc);
  assert.deepEqual(problems, []);
  return value;
};
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// ---- the database file -----------------------------------------------------------------
test('a fresh database has the current schema', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name),
    ['employee_roles', 'employees', 'income_categories', 'jobs', 'locations', 'money_entries', 'parties', 'shift_breaks', 'shift_employees', 'shift_tags', 'shifts', 'venues', 'wage_rates']);
  assert.deepEqual(columns(db, 'shifts'), ['id', 'job_id', 'location_id', 'work_date', 'start_at', 'end_at', 'shift_type', 'notes',
    'external_ref', 'created_at', 'updated_at', 'deleted_at']);
  assert.deepEqual(columns(db, 'shift_breaks'), ['id', 'shift_id', 'start_at', 'end_at', 'minutes']);
  assert.deepEqual(columns(db, 'employees'), ['id', 'name', 'archived', 'first', 'last', 'id_number', 'manager', 'is_me', 'notes']);
  assert.deepEqual(columns(db, 'employee_roles'), ['employee_id', 'role']);
  assert.deepEqual(columns(db, 'shift_employees'), ['shift_id', 'employee_id', 'start_at', 'end_at', 'tips_cents']);
  assert.deepEqual(columns(db, 'parties'), ['id', 'shift_id', 'name', 'guests', 'start_at', 'end_at', 'notes']);
  assert.deepEqual(columns(db, 'money_entries'), ['id', 'shift_id', 'category_id', 'value_cents']);
});

test('opening a file creates the schema once and reopening keeps the data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-db-'));
  const path = join(dir, 'bar.db');
  const db = openDb(path);
  db.exec("INSERT INTO venues (id, name) VALUES ('v', 'Kept')");
  db.close();
  const again = openDb(path);
  assert.equal(again.prepare('SELECT name FROM venues').get().name, 'Kept');
  again.close();
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.v')), [], 'nothing was set aside');
});

test('a database from another schema version is moved aside intact and a new one is started', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-db-'));
  const path = join(dir, 'bar.db');
  const old = new DatabaseSync(path);
  old.exec('PRAGMA journal_mode = WAL');
  old.exec("CREATE TABLE precious (x TEXT); INSERT INTO precious VALUES ('do not lose me'); PRAGMA user_version = 2");
  old.close();

  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(count(db, 'shifts'), 0, 'the new database is empty');
  const aside = readdirSync(dir).filter((f) => /^bar\.v2-.*\.db$/.test(f));
  assert.equal(aside.length, 1);
  const kept = new DatabaseSync(join(dir, aside[0]), { readOnly: true });
  assert.equal(kept.prepare('SELECT x FROM precious').get().x, 'do not lose me');
  kept.close();
  db.close();
  openDb(path).close();
  assert.equal(readdirSync(dir).filter((f) => /^bar\.v2-.*\.db$/.test(f)).length, 1, 'reopening does not set anything else aside');
});

test('an empty file is initialised in place, not set aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-db-'));
  const path = join(dir, 'bar.db');
  writeFileSync(path, '');
  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  db.close();
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.v0')), []);
});

// ---- schema constraints (a second line of defence behind the validator) --------------------
test('the schema itself rejects bad times, types, breaks, list names and money', () => {
  const { db, job } = seedDb();
  const cols = 'id, job_id, work_date, start_at, end_at, shift_type, created_at, updated_at';
  const insert = (over = {}) => {
    const r = { start: '2026-09-18T11:00', end: '2026-09-18T21:30', type: 'day', ...over };
    return db.prepare(`INSERT INTO shifts (${cols}) VALUES (?, ?, '2026-09-18', ?, ?, ?, 'x', 'x')`)
      .run(over.id ?? randomUUID(), job.id, r.start, r.end, r.type);
  };
  assert.doesNotThrow(() => insert());
  assert.doesNotThrow(() => db.prepare("INSERT INTO shifts (id, work_date, start_at, end_at, shift_type, created_at, updated_at) VALUES (?, '2026-09-18', '2026-09-18T11:00', '2026-09-18T12:00', 'day', 'x', 'x')")
    .run(randomUUID()), 'a shift needs no job');
  assert.doesNotThrow(() => db.prepare("INSERT INTO shifts (id, created_at, updated_at) VALUES (?, 'x', 'x')").run(randomUUID()), 'a shift needs no date, times or type at all');
  assert.throws(() => insert({ end: '2026-09-18T10:00' }), /CHECK constraint/, 'end before start');
  assert.throws(() => insert({ start: '2026-09-18T11:00Z', end: '2026-09-18T12:00Z' }), /CHECK constraint/, 'no zoned times');
  assert.throws(() => insert({ type: 'double' }), /CHECK constraint/, '"double" no longer exists');
  assert.throws(() => insert({ type: 'mid' }), /CHECK constraint/, 'day or night only');
  assert.throws(() => db.prepare("INSERT INTO shifts (id, work_date, start_at, shift_type, created_at, updated_at) VALUES (?, '2026-09-18', '2026-09-18T11:00', 'day', 'x', 'x')").run(randomUUID()),
    /CHECK constraint/, 'a start with no end');

  const shiftId = db.prepare('SELECT id FROM shifts LIMIT 1').get().id;
  const brk = (start, end, minutes) => db.prepare('INSERT INTO shift_breaks (id, shift_id, start_at, end_at, minutes) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), shiftId, start, end, minutes);
  assert.doesNotThrow(() => brk('2026-09-18T15:00', '2026-09-18T15:30', null));
  assert.doesNotThrow(() => brk('2026-09-18T18:00', '2026-09-18T18:15', null), 'a shift can have several breaks');
  assert.doesNotThrow(() => brk(null, null, 30));
  assert.throws(() => brk('2026-09-18T15:00', '2026-09-18T15:30', 30), /CHECK constraint/, 'range and duration together');
  assert.throws(() => brk(null, null, null), /CHECK constraint/, 'neither a range nor a duration');
  assert.throws(() => brk('2026-09-18T15:00', null, null), /CHECK constraint/, 'half a range');
  assert.throws(() => brk('2026-09-18T15:30', '2026-09-18T15:00', null), /CHECK constraint/, 'break ends before it starts');
  assert.throws(() => brk(null, null, 0), /CHECK constraint/, 'a zero-minute break');

  const name = (table, n) => db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`).run(randomUUID(), n);
  for (const table of ['locations', 'employees']) {
    assert.doesNotThrow(() => name(table, 'Ana'));
    assert.throws(() => name(table, 'ANA'), /UNIQUE constraint/, `${table}: a name is unique ignoring case`);
    assert.throws(() => name(table, ''), /CHECK constraint/, `${table}: a name can't be empty`);
  }
  // who worked the shift: times are both or neither, an end after its start, tips are never negative
  const ana = db.prepare("SELECT id FROM employees WHERE name = 'Ana'").get().id;
  assert.doesNotThrow(() => db.prepare('INSERT INTO employee_roles (employee_id, role) VALUES (?, ?)').run(ana, 'Bartender'));
  assert.throws(() => db.prepare('INSERT INTO employee_roles (employee_id, role) VALUES (?, ?)').run(ana, ''), /CHECK constraint/, 'a role is text, not empty');
  assert.throws(() => db.prepare('INSERT INTO employee_roles (employee_id, role) VALUES (?, ?)').run(ana, 'Bartender'), /UNIQUE constraint/, 'the same role twice on one employee');
  db.exec("INSERT INTO employees (id, name) VALUES ('e2', 'Ben')");
  assert.doesNotThrow(() => db.exec("UPDATE employees SET is_me = 1 WHERE id = 'e2'"));
  assert.throws(() => db.prepare('UPDATE employees SET is_me = 1 WHERE id = ?').run(ana), /UNIQUE constraint/, 'only one employee can be flagged as you');
  const staff = (emp, start, end, tips) => db.prepare('INSERT INTO shift_employees (shift_id, employee_id, start_at, end_at, tips_cents) VALUES (?, ?, ?, ?, ?)').run(shiftId, emp, start, end, tips);
  assert.doesNotThrow(() => staff(ana, null, null, null));
  assert.doesNotThrow(() => staff('e2', '2026-09-18T12:00', '2026-09-18T18:00', 12000));
  assert.throws(() => staff(ana, null, null, null), /UNIQUE constraint/, 'a person is on a shift once');
  db.exec("INSERT INTO employees (id, name) VALUES ('e3', 'Cleo')");
  assert.throws(() => staff('e3', '2026-09-18T12:00', null, null), /CHECK constraint/, 'half a pair of times');
  assert.throws(() => staff('e3', '2026-09-18T18:00', '2026-09-18T12:00', null), /CHECK constraint/, 'ends before it starts');
  assert.throws(() => staff('e3', null, null, -1), /CHECK constraint/, 'negative tips');
  assert.throws(() => staff(randomUUID(), null, null, null), /FOREIGN KEY constraint/, 'a real employee');

  // parties: every detail is optional, but what is given has to make sense
  const party = (nm, guests, start, end) => db.prepare('INSERT INTO parties (id, shift_id, name, guests, start_at, end_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), shiftId, nm, guests, start, end);
  assert.doesNotThrow(() => party(null, null, null, null), 'a party with nothing said about it');
  assert.doesNotThrow(() => party('Smith 40th', 40, '2026-09-18T19:00', '2026-09-18T22:00'));
  assert.doesNotThrow(() => party(null, null, null, null), 'and a shift can have several');
  assert.throws(() => party(null, 0, null, null), /CHECK constraint/, 'no guests is not a party');
  assert.throws(() => party('', null, null, null), /CHECK constraint/);
  assert.throws(() => party(null, null, '2026-09-18T19:00', null), /CHECK constraint/, 'half a pair of times');
  assert.throws(() => party(null, null, '2026-09-18T22:00', '2026-09-18T19:00'), /CHECK constraint/);
  const money = (cat, value) => db.prepare('INSERT INTO money_entries (id, shift_id, category_id, value_cents) VALUES (?, ?, ?, ?)').run(randomUUID(), shiftId, cat, value);
  assert.doesNotThrow(() => money(TIPS, 5));
  assert.throws(() => money(TIPS, -5), /CHECK constraint/);
  assert.throws(() => money(randomUUID(), 5), /FOREIGN KEY constraint/, 'an entry needs a real income type');
  assert.deepEqual(db.prepare('SELECT id, name, system FROM income_categories').all().map((c) => ({ ...c })), [{ id: TIPS, name: 'Tips', system: 1 }], 'a new database starts with Tips');
});

// ---- shift store -----------------------------------------------------------------------
test('a shift reads back exactly as stored: type, breaks, tips', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const id = randomUUID();
  store.put(id, valid(longDoc(job.id, {
    tags: ['busy'],
    breaks: [{ start_at: '2026-09-18T17:00', end_at: '2026-09-18T17:20' }, { minutes: 45 }, { start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }],
    money_entries: [{ value_cents: 21000 }, { value_cents: 34550 }, { value_cents: 500 }],
  })));
  const s = store.get(id);
  assert.equal(s.shift_type, 'night');
  assert.deepEqual(s.breaks, [
    { start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }, { start_at: '2026-09-18T17:00', end_at: '2026-09-18T17:20' }, { minutes: 45 },
  ], 'ranges come back in time order, then plain lengths');
  assert.deepEqual(s.money_entries.map((m) => [m.category_id, m.value_cents]), [[TIPS, 21000], [TIPS, 34550], [TIPS, 500]]);
  assert.ok(!('shift_id' in s.money_entries[0]) && !('tz' in s) && !('tip_periods' in s) && !('break_start' in s) && !('section' in s) && !('part' in s.money_entries[0]));
  assert.deepEqual([s.job_id, s.location_id, s.employees, s.parties], [job.id, null, [], []]);
  const bare = randomUUID();
  store.put(bare, valid(shiftDoc(null)));
  assert.deepEqual(store.get(bare).breaks, [], 'no breaks is an empty list');
  const empty = randomUUID();
  store.put(empty, valid({}));
  assert.deepEqual([store.get(empty).work_date, store.get(empty).start_at, store.get(empty).shift_type], [null, null, null], 'a shift can be saved with nothing filled in');
});

test('put is idempotent: same id twice gives one shift, replacing the breaks, tags and tips', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const id = randomUUID();
  const first = store.put(id, valid(longDoc(job.id, { tags: ['busy'], breaks: [{ minutes: 30 }, { minutes: 15 }], money_entries: [{ value_cents: 100 }, { value_cents: 250 }] })));
  assert.equal(first.created, true);
  assert.equal(count(db, 'shift_breaks'), 2);
  const second = store.put(id, valid(shiftDoc(job.id, { notes: 'edited', breaks: [{ start_at: '2026-09-18T20:00', end_at: '2026-09-18T20:20' }], money_entries: [{ value_cents: 999 }] })));
  assert.equal(second.created, false);
  assert.deepEqual([count(db, 'shifts'), count(db, 'money_entries'), count(db, 'shift_breaks')], [1, 1, 1]);
  assert.deepEqual([second.shift.shift_type, second.shift.breaks], ['night', [{ start_at: '2026-09-18T20:00', end_at: '2026-09-18T20:20' }]]);
  assert.deepEqual(second.shift.money_entries.map((m) => m.value_cents), [999]);
  assert.deepEqual(second.shift.tags, []);
  assert.equal(second.shift.created_at, first.shift.created_at);
  const cleared = store.put(id, valid(shiftDoc(job.id, { breaks: [] })));
  assert.deepEqual([cleared.shift.breaks, count(db, 'shift_breaks')], [[], 0], 'an empty list removes them all');
});

test('two shifts on the same date are independent', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  store.put(randomUUID(), valid(shiftDoc(job.id, { start_at: '2026-09-18T11:00', end_at: '2026-09-18T17:00', shift_type: 'day' })));
  store.put(randomUUID(), valid(shiftDoc(job.id, { work_date: '2026-09-18' })));
  assert.equal(store.list({ from: '2026-09-18', to: '2026-09-18' }).shifts.length, 2);
});

test('put rejects an unknown job and writes nothing; a failed put rolls back everything', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  assert.throws(() => store.put(randomUUID(), valid(shiftDoc(randomUUID()))), /no such job/);
  assert.equal(count(db, 'shifts'), 0);
  const dupe = randomUUID();
  const doc = valid(shiftDoc(job.id));
  // the validator rejects duplicate ids, so add them after validation to reach the DB constraint
  doc.money_entries = [{ id: dupe, value_cents: 1, part: 'night' }, { id: dupe, value_cents: 2, part: 'night' }];
  assert.throws(() => store.put(randomUUID(), doc), /UNIQUE constraint/);
  assert.deepEqual([count(db, 'shifts'), count(db, 'money_entries')], [0, 0]);
});

test('patch merges fields and re-validates; the breaks and type can change; failed patches change nothing', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const id = randomUUID();
  store.put(id, valid(longDoc(job.id, { tags: ['busy'], money_entries: [{ value_cents: 100 }, { value_cents: 300 }] })));
  const noted = store.patch(id, { notes: 'late close' });
  assert.deepEqual([noted.notes, noted.tags, noted.money_entries.length, noted.shift_type], ['late close', ['busy'], 2, 'night']);
  const broke = store.patch(id, { breaks: [{ start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }, { minutes: 10 }] });
  assert.deepEqual(broke.breaks, [{ start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }, { minutes: 10 }]);
  assert.throws(() => store.patch(id, { breaks: [{ minutes: 20, start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }] }), /not both/);
  assert.equal(store.get(id).breaks.length, 2, 'a failed patch changes nothing');
  assert.deepEqual(store.patch(id, { notes: 'again' }).breaks.length, 2, 'a patch that leaves breaks out keeps them');
  const cleared = store.patch(id, { breaks: [] });
  assert.deepEqual(cleared.breaks, []);
  const retyped = store.patch(id, { shift_type: 'day' });
  assert.deepEqual(retyped.money_entries.map((m) => m.value_cents), [100, 300], 'income is untouched by a type change');
  const untyped = store.patch(id, { shift_type: null });
  assert.equal(untyped.shift_type, null, 'the type can be cleared, since it is optional');
  assert.throws(() => store.patch(id, { shift_type: 'double' }), /must be one of: day, night/, '"double" no longer exists');
  assert.throws(() => store.patch(id, { end_at: '2026-09-18T10:00' }), /must be after start_at/);
  assert.throws(() => store.patch(id, { hours: 3 }), /unknown field/);
  assert.throws(() => store.patch(randomUUID(), { notes: 'x' }), /shift not found/);
});

test('soft delete keeps everything; hard delete cascades; put revives', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const id = randomUUID();
  store.put(id, valid(longDoc(job.id, { tags: ['busy'], money_entries: [{ value_cents: 100 }, { value_cents: 5 }] })));
  store.remove(id);
  assert.equal(store.list().shifts.length, 0);
  assert.equal(store.list({ includeDeleted: true }).shifts.length, 1);
  assert.ok(store.get(id).deleted_at);
  assert.deepEqual([count(db, 'money_entries'), count(db, 'shift_tags')], [2, 1]);
  store.put(id, valid(shiftDoc(job.id)));
  assert.equal(store.get(id).deleted_at, null);
  store.remove(id, { hard: true });
  assert.equal(store.get(id), null);
  assert.deepEqual([count(db, 'money_entries'), count(db, 'shift_tags')], [0, 0]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('list pages newest-first with a cursor and no duplicates', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  for (let day = 10; day < 15; day++) {
    store.put(randomUUID(), valid(shiftDoc(job.id, { start_at: `2026-09-${day}T17:00`, end_at: `2026-09-${day}T23:00` })));
  }
  const seen = [];
  let cursor;
  do {
    const page = store.list({ limit: 2, cursor });
    seen.push(...page.shifts.map((s) => s.work_date));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, ['2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10']);
});

test('shifts with no start time yet sort last and still page correctly, with no duplicates or drops', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const timedIds = [];
  for (let day = 10; day < 13; day++) {
    const id = randomUUID();
    store.put(id, valid(shiftDoc(job.id, { start_at: `2026-09-${day}T17:00`, end_at: `2026-09-${day}T23:00` })));
    timedIds.push(id);
  }
  const undatedIds = [randomUUID(), randomUUID(), randomUUID()].sort();
  for (const id of undatedIds) store.put(id, valid({}));

  const seenIds = [];
  let cursor;
  do {
    const page = store.list({ limit: 2, cursor });
    seenIds.push(...page.shifts.map((s) => s.id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(new Set(seenIds).size, 6, 'no duplicates');
  assert.deepEqual(seenIds.slice(0, 3), [...timedIds].reverse(), 'the dated shifts come first, newest first');
  assert.deepEqual(seenIds.slice(3).sort(), undatedIds, 'the undated ones all still show up, after the dated ones');
});

test('tips add, patch, remove', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const night = randomUUID();
  const { shift } = store.put(night, valid(shiftDoc(job.id)));
  const auto = store.addMoney(night, { value_cents: 500 });
  assert.equal(auto.category_id, TIPS, 'no type given: tips');
  const patched = store.patchMoney(auto.id, { value_cents: 700 });
  assert.equal(patched.value_cents, 700);
  assert.throws(() => store.patchMoney(auto.id, { value_cents: 1.5 }), /whole number of cents/);
  assert.ok(store.get(night).updated_at >= shift.updated_at);
  store.removeMoney(auto.id);
  assert.equal(store.get(night).money_entries.length, 0);
  assert.throws(() => store.addMoney(randomUUID(), { value_cents: 1 }), /shift not found/);
});

// ---- migrations ------------------------------------------------------------------------
const GLOB_DATE = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

// A database file as an older version wrote it: start from a fresh one and put the tables that changed back
// the way they were, so the migrations are tested against the real old shapes, not the new ones.
function oldDatabase(path, version) {
  const db = openDb(path);
  db.exec('PRAGMA foreign_keys = OFF');
  if (version <= 8) {
    db.exec(`   -- v8: employees had just name/archived/role/notes, and role was a single free-text column
      DROP INDEX employees_is_me;
      DROP TABLE employee_roles;
      DROP TABLE employees;
      CREATE TABLE employees (
        id       TEXT PRIMARY KEY,
        name     TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 100),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        role     TEXT CHECK (role IS NULL OR length(role) BETWEEN 1 AND 50),
        notes    TEXT
      ) STRICT;`);
  }
  if (version <= 6) {
    db.exec(`   -- v6: coworkers were a plain name list, who worked a shift carried nothing else, and there were no parties
      DROP INDEX shift_employees_employee_id; DROP TABLE shift_employees;
      DROP INDEX parties_shift_id; DROP TABLE parties;
      DROP TABLE employees;
      CREATE TABLE coworkers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 100),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
      ) STRICT;
      CREATE TABLE shift_coworkers (
        shift_id TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
        coworker_id TEXT NOT NULL REFERENCES coworkers (id),
        PRIMARY KEY (shift_id, coworker_id)
      ) STRICT;
      CREATE INDEX shift_coworkers_coworker_id ON shift_coworkers (coworker_id);`);
  }
  if (version <= 5) {
    db.exec(`
      DROP TABLE wage_rates;
      CREATE TABLE wage_rates (   -- v5: one wage history per job
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
        effective_from TEXT NOT NULL CHECK (effective_from GLOB ${GLOB_DATE}),
        rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
        note TEXT,
        UNIQUE (job_id, effective_from)
      ) STRICT;`);
  }
  if (version <= 4) {
    db.exec(`
      DROP INDEX money_entries_shift_id;
      DROP TABLE money_entries;
      DROP TABLE income_categories;
      CREATE TABLE money_entries (   -- v4: tips were the only category
        id TEXT PRIMARY KEY,
        shift_id TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (category IN ('tips')),
        value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
        part TEXT CHECK (part IS NULL OR part IN ('day', 'night'))
      ) STRICT;
      CREATE INDEX money_entries_shift_id ON money_entries (shift_id);`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

const backups = (dir) => readdirSync(dir).filter((f) => f.endsWith('.bak'));

// v8 dropped "double" shifts and the money_entries.part column: a schema-breaking change with no
// migration written for it (existing data is treated as disposable; see server/db.js's own comment
// about only migrating when the data is worth carrying over). So v4, v5, v6 and v7 databases, which
// used to migrate all the way forward, now all take the "no path" route: set aside intact, untouched.
for (const version of [4, 5, 6, 7]) {
  test(`a v${version} database has no path to v8, so it is set aside intact rather than migrated`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'bar2000-mig-'));
    const path = join(dir, 'bar.db');
    const old = oldDatabase(path, version);
    old.exec("INSERT INTO venues (id, name) VALUES ('v', 'Bar')");
    old.close();

    const db = openDb(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'a fresh database takes its place');
    assert.equal(count(db, 'venues'), 0, 'the fresh database is empty');
    assert.equal(backups(dir).length, 0, 'nothing was migrated, so no backup was made');
    const aside = readdirSync(dir).filter((f) => new RegExp(`^bar\\.v${version}-.*\\.db$`).test(f));
    assert.equal(aside.length, 1, 'the original file is kept, renamed aside');
    const kept = new DatabaseSync(join(dir, aside[0]), { readOnly: true });
    assert.equal(kept.prepare('SELECT name FROM venues').get().name, 'Bar', 'its data is untouched');
    kept.close();
    db.close();
  });
}

test("a v8 database migrates to v9, folding each employee's single role into employee_roles", () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-mig-'));
  const path = join(dir, 'bar.db');
  const old = oldDatabase(path, 8);
  old.exec("INSERT INTO employees (id, name, role, notes) VALUES ('e1', 'Ana', 'Bartender', 'x')");
  old.exec("INSERT INTO employees (id, name, role) VALUES ('e2', 'Ben', NULL)");
  old.close();

  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(backups(dir).length, 1, 'a backup was made before migrating');
  assert.deepEqual(columns(db, 'employees'), ['id', 'name', 'archived', 'first', 'last', 'id_number', 'manager', 'is_me', 'notes']);
  assert.deepEqual(db.prepare("SELECT role FROM employee_roles WHERE employee_id = 'e1'").all().map((r) => r.role), ['Bartender']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM employee_roles WHERE employee_id = 'e2'").get().n, 0, 'no role, no row');
  const e1 = db.prepare("SELECT name, notes, manager, is_me FROM employees WHERE id = 'e1'").get();
  assert.deepEqual([e1.name, e1.notes, e1.manager, e1.is_me], ['Ana', 'x', 0, 0]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // Putting someone on a shift exercises shift_employees' employee_id foreign key: the v8->v9 step below
  // once got this wrong (see the v9->v10 test), so a real insert here is the regression guard for it.
  db.exec(`INSERT INTO shifts (id, created_at, updated_at) VALUES ('s1', 'x', 'x')`);
  assert.doesNotThrow(() => db.prepare('INSERT INTO shift_employees (shift_id, employee_id) VALUES (?, ?)').run('s1', 'e1'));
  db.close();
});

// The first cut of the v8->v9 step above (before it was fixed to avoid this) used `ALTER TABLE employees
// RENAME TO employees_v8`. SQLite's RENAME rewrites *other* tables' REFERENCES clauses to follow the new
// name, so shift_employees.employee_id silently became `REFERENCES employees_v8 (id)` — and once
// employees_v8 was dropped, every attempt to put someone on a shift failed with "no such table:
// main.employees_v8". v9->v10 repairs a database that already ran that buggy step.
test('a v9 database with the dangling employees_v8 reference migrates to v10, repairing shift_employees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-mig-'));
  const path = join(dir, 'bar.db');

  // Build a v10-shaped database, then replay the real bug: employee_roles didn't exist yet at the point the
  // original buggy migration ran, so it re-creates fresh afterwards, unaffected; shift_employees already
  // existed, so the rename silently repoints its REFERENCES clause at employees_v8, exactly as it did live.
  const seed = openDb(':memory:');
  seed.exec("INSERT INTO employees (id, name) VALUES ('e1', 'Ana')");
  seed.exec("INSERT INTO shifts (id, created_at, updated_at) VALUES ('s1', 'x', 'x')");
  seed.exec("INSERT INTO shift_employees (shift_id, employee_id) VALUES ('s1', 'e1')");
  seed.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE employee_roles;
    DROP INDEX employees_is_me;
    ALTER TABLE employees RENAME TO employees_v8;
    CREATE TABLE employees (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 100),
      archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      first      TEXT CHECK (first IS NULL OR length(first) BETWEEN 1 AND 60),
      last       TEXT CHECK (last IS NULL OR length(last) BETWEEN 1 AND 60),
      id_number  TEXT CHECK (id_number IS NULL OR length(id_number) BETWEEN 1 AND 50),
      manager    INTEGER NOT NULL DEFAULT 0 CHECK (manager IN (0, 1)),
      is_me      INTEGER NOT NULL DEFAULT 0 CHECK (is_me IN (0, 1)),
      notes      TEXT
    ) STRICT;
    INSERT INTO employees SELECT * FROM employees_v8;
    DROP TABLE employees_v8;
    CREATE UNIQUE INDEX employees_is_me ON employees (is_me) WHERE is_me = 1;
    CREATE TABLE employee_roles (
      employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 50),
      PRIMARY KEY (employee_id, role)
    ) STRICT;
    PRAGMA user_version = 9;
    PRAGMA foreign_keys = ON;
  `);
  seed.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  seed.close();

  const broken = new DatabaseSync(path);
  assert.match(broken.prepare("SELECT sql FROM sqlite_master WHERE name = 'shift_employees'").get().sql, /employees_v8/, 'the fixture really is broken');
  broken.close();

  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(backups(dir).length, 1, 'a backup was made before repairing');
  assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'shift_employees'").get().sql, /employees_v8/);
  const row = db.prepare('SELECT shift_id, employee_id FROM shift_employees').get();
  assert.deepEqual([row.shift_id, row.employee_id], ['s1', 'e1'], 'the existing row survives the repair');
  assert.doesNotThrow(() => db.prepare("INSERT INTO employees (id, name) VALUES ('e2', 'Ben')").run()
    && db.prepare('INSERT INTO shift_employees (shift_id, employee_id) VALUES (?, ?)').run('s1', 'e2'), 'putting someone new on a shift works again');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('a version with no path to the current one is still set aside, not touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-mig-'));
  const path = join(dir, 'bar.db');
  const odd = new DatabaseSync(path);
  odd.exec("CREATE TABLE precious (x TEXT); INSERT INTO precious VALUES ('keep me'); PRAGMA user_version = 3");
  odd.close();
  openDb(path).close();
  assert.equal(backups(dir).length, 0, 'no migration, so no backup copy');
  const aside = readdirSync(dir).filter((f) => /^bar\.v3-.*\.db$/.test(f));
  assert.equal(aside.length, 1);
  assert.equal(new DatabaseSync(join(dir, aside[0]), { readOnly: true }).prepare('SELECT x FROM precious').get().x, 'keep me');
});

test('two processes opening an old database at the same moment both work, and the set-aside file is honestly labelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-race-'));
  const path = join(dir, 'bar.db');
  const old = oldDatabase(path, 5);
  old.exec("INSERT INTO shifts (id, work_date, start_at, end_at, shift_type, created_at, updated_at) VALUES ('s', '2026-09-18', '2026-09-18T17:00', '2026-09-19T01:00', 'night', 'x', 'x')");
  old.close();

  const dbUrl = new URL('../server/db.js', import.meta.url).href;
  const script = `import(${JSON.stringify(dbUrl)}).then((m) => { const db = m.openDb(${JSON.stringify(path)}); console.log(db.prepare('PRAGMA user_version').get().user_version); db.close(); })`;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out: out.trim().split('\n').pop(), err }));
  });
  const results = await Promise.all([run(), run(), run()]);
  for (const r of results) assert.deepEqual([r.code, r.out], [0, String(SCHEMA_VERSION)], r.err);

  // v5 has no path to v8, so the race is over who gets to set the old file aside, not who migrates it.
  const db = openDb(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 0, 'a fresh database, not the old one');
  db.close();
  const aside = readdirSync(dir).filter((f) => /^bar\.v5-.*\.db$/.test(f));
  assert.equal(aside.length, 1, 'exactly one set-aside file, however many processes raced for it');
  const kept = new DatabaseSync(join(dir, aside[0]), { readOnly: true });
  assert.equal(kept.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 1, 'its data is intact');
  kept.close();
});
