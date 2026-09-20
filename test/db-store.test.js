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
import { seedDb, shiftDoc, doubleDoc } from './helpers.js';

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
    ['employees', 'income_categories', 'jobs', 'locations', 'money_entries', 'parties', 'shift_breaks', 'shift_employees', 'shift_tags', 'shifts', 'venues', 'wage_rates']);
  assert.deepEqual(columns(db, 'shifts'), ['id', 'job_id', 'location_id', 'work_date', 'start_at', 'end_at', 'shift_type', 'notes',
    'external_ref', 'created_at', 'updated_at', 'deleted_at']);
  assert.deepEqual(columns(db, 'shift_breaks'), ['id', 'shift_id', 'start_at', 'end_at', 'minutes']);
  assert.deepEqual(columns(db, 'employees'), ['id', 'name', 'archived', 'role', 'notes']);
  assert.deepEqual(columns(db, 'shift_employees'), ['shift_id', 'employee_id', 'start_at', 'end_at', 'tips_cents']);
  assert.deepEqual(columns(db, 'parties'), ['id', 'shift_id', 'name', 'guests', 'start_at', 'end_at', 'notes']);
  assert.deepEqual(columns(db, 'money_entries'), ['id', 'shift_id', 'category_id', 'value_cents', 'part']);
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
    const r = { start: '2026-09-18T11:00', end: '2026-09-18T21:30', type: 'double', ...over };
    return db.prepare(`INSERT INTO shifts (${cols}) VALUES (?, ?, '2026-09-18', ?, ?, ?, 'x', 'x')`)
      .run(over.id ?? randomUUID(), job.id, r.start, r.end, r.type);
  };
  assert.doesNotThrow(() => insert());
  assert.doesNotThrow(() => db.prepare("INSERT INTO shifts (id, work_date, start_at, end_at, shift_type, created_at, updated_at) VALUES (?, '2026-09-18', '2026-09-18T11:00', '2026-09-18T12:00', 'day', 'x', 'x')")
    .run(randomUUID()), 'a shift needs no job');
  assert.throws(() => insert({ end: '2026-09-18T10:00' }), /CHECK constraint/, 'end before start');
  assert.throws(() => insert({ start: '2026-09-18T11:00Z', end: '2026-09-18T12:00Z' }), /CHECK constraint/, 'no zoned times');
  assert.throws(() => insert({ type: 'mid' }), /CHECK constraint/, 'day, night or double only');

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
  assert.throws(() => db.prepare("UPDATE employees SET role = '' WHERE name = 'Ana'").run(), /CHECK constraint/, 'a role is text or nothing, not empty');

  // who worked the shift: times are both or neither, an end after its start, tips are never negative
  const ana = db.prepare("SELECT id FROM employees WHERE name = 'Ana'").get().id;
  db.exec("INSERT INTO employees (id, name) VALUES ('e2', 'Ben')");
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
  const money = (cat, value, part) => db.prepare('INSERT INTO money_entries (id, shift_id, category_id, value_cents, part) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), shiftId, cat, value, part);
  assert.doesNotThrow(() => money(TIPS, 5, null));
  assert.doesNotThrow(() => money(TIPS, 5, 'day'));
  assert.throws(() => money(TIPS, -5, 'day'), /CHECK constraint/);
  assert.throws(() => money(randomUUID(), 5, 'day'), /FOREIGN KEY constraint/, 'an entry needs a real income type');
  assert.throws(() => money(TIPS, 5, 'double'), /CHECK constraint/);
  assert.deepEqual(db.prepare('SELECT id, name, system FROM income_categories').all().map((c) => ({ ...c })), [{ id: TIPS, name: 'Tips', system: 1 }], 'a new database starts with Tips');
});

// ---- shift store -----------------------------------------------------------------------
test('a shift reads back exactly as stored: type, breaks, tips by part', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const id = randomUUID();
  store.put(id, valid(doubleDoc(job.id, {
    tags: ['busy'],
    breaks: [{ start_at: '2026-09-18T17:00', end_at: '2026-09-18T17:20' }, { minutes: 45 }, { start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }],
    money_entries: [{ value_cents: 21000, part: 'day' }, { value_cents: 34550, part: 'night' }, { value_cents: 500, part: null }],
  })));
  const s = store.get(id);
  assert.equal(s.shift_type, 'double');
  assert.deepEqual(s.breaks, [
    { start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }, { start_at: '2026-09-18T17:00', end_at: '2026-09-18T17:20' }, { minutes: 45 },
  ], 'ranges come back in time order, then plain lengths');
  assert.deepEqual(s.money_entries.map((m) => [m.category_id, m.value_cents, m.part]), [[TIPS, 21000, 'day'], [TIPS, 34550, 'night'], [TIPS, 500, null]]);
  assert.ok(!('shift_id' in s.money_entries[0]) && !('tz' in s) && !('tip_periods' in s) && !('break_start' in s) && !('section' in s));
  assert.deepEqual([s.job_id, s.location_id, s.employees, s.parties], [job.id, null, [], []]);
  const bare = randomUUID();
  store.put(bare, valid(shiftDoc(null)));
  assert.deepEqual(store.get(bare).breaks, [], 'no breaks is an empty list');
});

test('put is idempotent: same id twice gives one shift, replacing the breaks, tags and tips', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const id = randomUUID();
  const first = store.put(id, valid(doubleDoc(job.id, { tags: ['busy'], breaks: [{ minutes: 30 }, { minutes: 15 }], money_entries: [{ value_cents: 100, part: 'day' }, { value_cents: 250, part: 'night' }] })));
  assert.equal(first.created, true);
  assert.equal(count(db, 'shift_breaks'), 2);
  const second = store.put(id, valid(shiftDoc(job.id, { notes: 'edited', breaks: [{ start_at: '2026-09-18T20:00', end_at: '2026-09-18T20:20' }], money_entries: [{ value_cents: 999 }] })));
  assert.equal(second.created, false);
  assert.deepEqual([count(db, 'shifts'), count(db, 'money_entries'), count(db, 'shift_breaks')], [1, 1, 1]);
  assert.deepEqual([second.shift.shift_type, second.shift.breaks], ['night', [{ start_at: '2026-09-18T20:00', end_at: '2026-09-18T20:20' }]]);
  assert.deepEqual(second.shift.money_entries.map((m) => [m.value_cents, m.part]), [[999, 'night']]); // attached to the shift's type
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
  store.put(id, valid(doubleDoc(job.id, { tags: ['busy'], money_entries: [{ value_cents: 100, part: 'day' }, { value_cents: 300, part: null }] })));
  const noted = store.patch(id, { notes: 'late close' });
  assert.deepEqual([noted.notes, noted.tags, noted.money_entries.length, noted.shift_type], ['late close', ['busy'], 2, 'double']);
  const broke = store.patch(id, { breaks: [{ start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }, { minutes: 10 }] });
  assert.deepEqual(broke.breaks, [{ start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }, { minutes: 10 }]);
  assert.throws(() => store.patch(id, { breaks: [{ minutes: 20, start_at: '2026-09-18T15:00', end_at: '2026-09-18T15:30' }] }), /not both/);
  assert.equal(store.get(id).breaks.length, 2, 'a failed patch changes nothing');
  assert.deepEqual(store.patch(id, { notes: 'again' }).breaks.length, 2, 'a patch that leaves breaks out keeps them');
  const cleared = store.patch(id, { breaks: [] });
  assert.deepEqual(cleared.breaks, []);
  assert.throws(() => store.patch(id, { shift_type: 'night' }), /this is a night shift, so its income can't be for day/, 'income for the day cannot stay on a night shift');
  const fixed = store.patch(id, { shift_type: 'day', money_entries: [{ value_cents: 100 }, { value_cents: 300 }] });
  assert.deepEqual(fixed.money_entries.map((m) => m.part), ['day', 'day']);
  const back = store.patch(id, { shift_type: 'double' });
  assert.deepEqual(back.money_entries.map((m) => m.part), ['day', 'day'], 'going back to a double keeps the parts');
  assert.throws(() => store.patch(id, { end_at: '2026-09-18T10:00' }), /must be after start_at/);
  assert.throws(() => store.patch(id, { hours: 3 }), /unknown field/);
  assert.throws(() => store.patch(randomUUID(), { notes: 'x' }), /shift not found/);
});

test('changing a shift to day or night sets every combined tip to that type', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const id = randomUUID();
  store.put(id, valid(doubleDoc(job.id, { money_entries: [{ value_cents: 100, part: null }, { value_cents: 200, part: 'night' }] })));
  assert.deepEqual(store.patch(id, { shift_type: 'night' }).money_entries.map((m) => m.part), ['night', 'night']);
});

test('soft delete keeps everything; hard delete cascades; put revives', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const id = randomUUID();
  store.put(id, valid(doubleDoc(job.id, { tags: ['busy'], money_entries: [{ value_cents: 100, part: 'day' }, { value_cents: 5, part: null }] })));
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

test('tips add, patch, remove: checked against the shift type', () => {
  const { db, job } = seedDb();
  const store = shiftStore(db);
  const night = randomUUID();
  const { shift } = store.put(night, valid(shiftDoc(job.id)));
  const auto = store.addMoney(night, { value_cents: 500 });
  assert.equal(auto.part, 'night', 'a night shift attaches tips to night');
  assert.throws(() => store.addMoney(night, { value_cents: 5, part: 'day' }), /this is a night shift/);
  const patched = store.patchMoney(auto.id, { value_cents: 700 });
  assert.deepEqual([patched.value_cents, patched.part], [700, 'night']);
  assert.throws(() => store.patchMoney(auto.id, { value_cents: 1.5 }), /whole number of cents/);
  assert.throws(() => store.patchMoney(auto.id, { part: 'day' }), /this is a night shift/);

  const dbl = randomUUID();
  store.put(dbl, valid(doubleDoc(job.id)));
  assert.equal(store.addMoney(dbl, { value_cents: 100 }).part, null, 'combined on a double');
  assert.equal(store.addMoney(dbl, { value_cents: 100, part: 'day' }).part, 'day');
  assert.equal(store.patchMoney(store.get(dbl).money_entries[1].id, { part: 'night' }).part, 'night');
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

const shapeOf = (d) => [
  ...d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => `${t.name}(${columns(d, t.name)})`),
  ...d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((i) => `index ${i.name}`),
];
const backups = (dir) => readdirSync(dir).filter((f) => f.endsWith('.bak'));

test('a v5 database is migrated (on to the current version): one wage history, the first rate kept where two jobs shared a date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-mig-'));
  const path = join(dir, 'bar.db');
  const old = oldDatabase(path, 5);
  old.exec("INSERT INTO venues (id, name) VALUES ('v', 'Bar'); INSERT INTO jobs (id, venue_id, title) VALUES ('j1', 'v', 'Bartender'), ('j2', 'v', 'Barback')");
  const rate = (id, job, from, cents, note) => old.prepare('INSERT INTO wage_rates VALUES (?, ?, ?, ?, ?)').run(id, job, from, cents, note);
  rate('r1', 'j1', '2026-01-01', 1125, 'annual bump');
  rate('r2', 'j1', '2026-06-01', 1300, null);
  rate('r3', 'j2', '2026-01-01', 900, 'same date, other job');
  old.close();

  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(backups(dir).filter((f) => f.startsWith('bar.v5-')).length, 1, 'the original was copied first');
  assert.deepEqual(db.prepare('SELECT id, effective_from, rate_cents, note FROM wage_rates ORDER BY effective_from').all().map((r) => ({ ...r })),
    [{ id: 'r1', effective_from: '2026-01-01', rate_cents: 1125, note: 'annual bump' }, { id: 'r2', effective_from: '2026-06-01', rate_cents: 1300, note: null }]);
  assert.deepEqual(columns(db, 'wage_rates'), ['id', 'effective_from', 'rate_cents', 'note']);
  assert.deepEqual(shapeOf(db), shapeOf(openDb(':memory:')), 'the same tables, columns and indexes as a fresh database');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
  openDb(path).close();
  assert.equal(backups(dir).length, 1, 'reopening does not migrate or back up again');
});

test('a v4 database is carried all the way to the current version: tips kept as Tips, wages merged, one backup of the original', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-mig-'));
  const path = join(dir, 'bar.db');
  const old = oldDatabase(path, 4);
  const shift = randomUUID();
  old.exec(`INSERT INTO shifts (id, work_date, start_at, end_at, shift_type, created_at, updated_at) VALUES ('${shift}', '2026-09-18', '2026-09-18T17:00', '2026-09-19T01:00', 'double', 'x', 'x')`);
  for (const [cents, part] of [[21000, "'day'"], [34550, "'night'"], [500, 'NULL']]) {
    old.exec(`INSERT INTO money_entries (id, shift_id, category, value_cents, part) VALUES ('${randomUUID()}', '${shift}', 'tips', ${cents}, ${part})`);
  }
  old.exec("INSERT INTO venues (id, name) VALUES ('v', 'Bar'); INSERT INTO jobs (id, venue_id, title) VALUES ('j', 'v', 'Bartender'); INSERT INTO wage_rates VALUES ('r', 'j', '2026-01-01', 1000, NULL)");
  old.close();

  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(backups(dir).filter((f) => f.startsWith('bar.v4-')).length, 1);
  assert.deepEqual(readdirSync(dir).filter((f) => /\.db$/.test(f) && f !== 'bar.db'), [], 'nothing was set aside: it was migrated');
  const kept = shiftStore(db).get(shift);
  assert.deepEqual(kept.money_entries.map((m) => [m.category_id, m.value_cents, m.part]), [[TIPS, 21000, 'day'], [TIPS, 34550, 'night'], [TIPS, 500, null]], 'same entries, same order');
  assert.deepEqual(db.prepare('SELECT name, system FROM income_categories').all().map((c) => ({ ...c })), [{ name: 'Tips', system: 1 }]);
  assert.equal(kept.derived.estimated_wage_cents, 8000, '8 paid hours at the migrated $10 rate');
  assert.deepEqual(shapeOf(db), shapeOf(openDb(':memory:')));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('a v6 database is migrated to v7: coworkers become employees with every shift link kept, and parties exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-mig-'));
  const path = join(dir, 'bar.db');
  const old = oldDatabase(path, 6);
  old.exec("INSERT INTO shifts (id, work_date, start_at, end_at, shift_type, created_at, updated_at) VALUES ('s1', '2026-09-18', '2026-09-18T17:00', '2026-09-19T01:00', 'night', 'x', 'x'), ('s2', '2026-09-19', '2026-09-19T17:00', '2026-09-20T01:00', 'night', 'x', 'x')");
  old.exec("INSERT INTO coworkers (id, name, archived) VALUES ('c1', 'Allen', 0), ('c2', 'Shawn B', 0), ('c3', 'Zoe', 1)");
  old.exec("INSERT INTO shift_coworkers VALUES ('s1', 'c1'), ('s1', 'c2'), ('s2', 'c3')");
  old.close();

  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(backups(dir).filter((f) => f.startsWith('bar.v6-')).length, 1, 'the original was copied first');
  assert.deepEqual(db.prepare('SELECT id, name, archived, role, notes FROM employees ORDER BY name').all().map((r) => ({ ...r })),
    [{ id: 'c1', name: 'Allen', archived: 0, role: null, notes: null }, { id: 'c2', name: 'Shawn B', archived: 0, role: null, notes: null }, { id: 'c3', name: 'Zoe', archived: 1, role: null, notes: null }],
    'same people, same ids, archived stays archived');
  const store = shiftStore(db);
  assert.deepEqual(store.get('s1').employees, [{ employee_id: 'c1', start_at: null, end_at: null, tips_cents: null }, { employee_id: 'c2', start_at: null, end_at: null, tips_cents: null }]);
  assert.deepEqual(store.get('s2').employees.map((e) => e.employee_id), ['c3']);
  assert.deepEqual(store.get('s1').parties, []);
  assert.equal(store.get('s1').derived.bartender_count, 3, 'you plus two people with no role, who count as bartenders');
  assert.deepEqual(shapeOf(db), shapeOf(openDb(':memory:')), 'the same tables, columns and indexes as a fresh database');
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

test('two processes opening an old database at the same moment both work, and every backup is honestly labelled', async () => {
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

  const db = openDb(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 1);
  db.close();
  const kept = backups(dir);
  assert.ok(kept.length >= 1, 'at least one backup');
  for (const file of kept) {
    const copy = new DatabaseSync(join(dir, file), { readOnly: true });
    assert.equal(`v${copy.prepare('PRAGMA user_version').get().user_version}`, file.match(/\.(v\d+)-/)[1], `${file} is the version its name says`);
    copy.close();
  }
});
