import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { shiftStore } from '../server/shiftStore.js';
import { planImport, runImport } from '../scripts/import-brv402.js';

const SRC = [
  { id: 'sh_1', date: '2026-07-03', start: 660, end: 1020, tips: 100, shiftType: 'Day' },
  { id: 'sh_2', date: '2026-07-03', start: 960, end: 30, tips: 291.5, shiftType: 'Night' }, // overnight wrap
  { id: 'sh_3', date: '2026-07-06', start: 900, end: 1200, tips: 50 }, // no shiftType: 3 PM start is night by the 2 PM cutoff
  { id: 'sh_4', date: '2026-07-08', start: 660, end: 1020, tips: null, shiftType: 'Day' }, // upcoming shift, no tips known yet
  { id: 'sh_5', date: '2026-07-09', start: null, end: null, tips: 10 }, // no times recorded
  { id: 'sh_6', date: '2026-07-10', start: 600, end: 600, tips: 5 }, // start equals end
];

test('planImport keeps wall-clock times, takes the shift type and tips rollup from brv402', () => {
  const plan = planImport(SRC);
  assert.deepEqual(plan.shifts.map((s) => s.ref), ['brv402:sh_1', 'brv402:sh_2', 'brv402:sh_3', 'brv402:sh_4']);

  const [a, b, c, d] = plan.shifts.map((s) => s.input);
  assert.deepEqual([a.start_at, a.end_at, a.shift_type], ['2026-07-03T11:00', '2026-07-03T17:00', 'day']);
  assert.deepEqual(a.money_entries, [{ value_cents: 10000 }]);

  assert.deepEqual([b.start_at, b.end_at, b.shift_type], ['2026-07-03T16:00', '2026-07-04T00:30', 'night']); // ends the next day
  assert.deepEqual(b.money_entries, [{ value_cents: 29150 }]);

  assert.equal(c.shift_type, 'night'); // untyped, guessed from the 3 PM start

  assert.equal(d.shift_type, 'day');
  assert.deepEqual(d.money_entries, [], 'no tips known yet: no money entry invented');

  assert.deepEqual(plan.skipped.map((s) => s.id).sort(), ['sh_5', 'sh_6']);
});

test('runImport writes once and is idempotent on re-run', () => {
  const db = openDb(':memory:');
  const plan = planImport(SRC);
  const first = runImport(db, plan);
  assert.deepEqual([first.created, first.existing], [4, 0]);
  const second = runImport(db, plan);
  assert.deepEqual([second.created, second.existing], [0, 4]);

  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.deepEqual([n('shifts'), n('money_entries')], [4, 3]);
  assert.equal(db.prepare('SELECT SUM(value_cents) AS c FROM money_entries').get().c, 44150);

  const store = shiftStore(db);
  const stored = store.get(store.idForExternalRef('brv402:sh_2'));
  assert.equal(stored.external_ref, 'brv402:sh_2');
  assert.deepEqual(stored.money_entries.map((m) => m.value_cents), [29150]);
  assert.equal(store.get(store.idForExternalRef('brv402:sh_4')).money_entries.length, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
