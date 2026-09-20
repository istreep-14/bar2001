import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { shiftStore } from '../server/shiftStore.js';
import { planImport, runImport } from '../scripts/import-brv8.js';
import { backupDb } from '../scripts/backup.js';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SRC = {
  settings: { workspace_name: 'Brava Bar' },
  wage_rates: [{ date: '2026-01-01', rate: 11.25, note: 'Annual bump' }],
  shifts: [
    { id: 'sh_1', date: '2026-07-03', start: 960, end: 30, shift_type: 'Night', location: 'Main', tags: ['busy'], notes: 'Fireworks eve', party_id: 'pt_1', break_start: 0, break_end: 20 },
    { id: 'sh_2', date: '2026-07-03', start: 660, end: 1020, shift_type: 'Day', location: null, tags: [], break_minutes: 30 },
    { id: 'sh_3', date: '2026-07-04', start: null, end: null },
    { id: 'sh_4', date: '2026-07-05', start: 600, end: 600 },
    { id: 'sh_5', date: '2026-07-06', start: 900, end: 1200 }, // no recorded type: a 3 PM start is night by the 2 PM cutoff
    { id: 'sh_6', date: '2026-07-07', start: 660, end: 1290, shift_type: 'Double' },
  ],
  income: [
    { id: 'in_1', kind: 'tips', amount: 291.5, shift_id: 'sh_1' },
    { id: 'in_2', kind: 'other', category: 'Venmo', amount: 40, shift_id: 'sh_1', note: 'door split' },
    { id: 'in_3', kind: 'paycheck', amount: 22, shift_id: 'sh_2' },
    { id: 'in_4', kind: 'other', category: 'Cash', amount: 85, shift_id: null, date: '2026-07-19' },
    { id: 'in_5', kind: 'tips', amount: 100, shift_id: 'sh_2' },
    { id: 'in_6', kind: 'tips', amount: 9, shift_id: null, date: '2026-07-19' },
    { id: 'in_7', kind: 'tips', amount: 50, shift_id: 'sh_6' },
  ],
  staff: [{ id: 'st_1' }],
  assignments: [],
  parties: [{ id: 'pt_1' }],
};

test('planImport keeps wall-clock times, takes the shift type and break from brv8, and imports tips only', () => {
  const plan = planImport(SRC);
  assert.deepEqual(plan.wageRates, [{ effective_from: '2026-01-01', rate_cents: 1125, note: 'Annual bump' }]);
  assert.deepEqual(plan.shifts.map((s) => s.ref), ['brv8:sh_1', 'brv8:sh_2', 'brv8:sh_5', 'brv8:sh_6']);

  const [a, b, c, d] = plan.shifts.map((s) => s.input);
  assert.deepEqual([a.start_at, a.end_at, a.shift_type], ['2026-07-03T16:00', '2026-07-04T00:30', 'night']); // no timezone, ends the next day
  assert.deepEqual(a.breaks, [{ start_at: '2026-07-04T00:00', end_at: '2026-07-04T00:20' }]); // a break after midnight, inside the shift
  assert.equal(plan.shifts[0].location, 'Main', 'brv8 location becomes a list entry, applied when written');
  assert.ok(!('section' in a) && !('location' in a));
  assert.deepEqual(a.tags, ['busy']);
  assert.deepEqual(a.money_entries, [{ value_cents: 29150, part: 'night' }]);
  assert.deepEqual([b.shift_type, b.breaks], ['day', [{ minutes: 30 }]]); // a duration-only break
  assert.deepEqual(c.breaks, [], 'no break recorded, none imported');
  assert.equal(plan.shifts[1].location, null);
  assert.deepEqual(b.money_entries, [{ value_cents: 10000, part: 'day' }]);
  assert.equal(c.shift_type, 'night');
  assert.deepEqual([d.shift_type, d.money_entries], ['double', [{ value_cents: 5000, part: null }]]); // combined on a double

  assert.deepEqual(plan.skipped.map((s) => s.id).sort(), ['in_6', 'sh_3', 'sh_4']);
  assert.deepEqual(plan.notImported.money, { count: 3, cents: 14700 }); // Venmo 40 + paycheck 22 + unlinked Cash 85
  assert.deepEqual([plan.notImported.staff, plan.notImported.parties, plan.notImported.shiftsLinkedToParty], [1, 1, 1]);
});

test('a break that does not fit inside its shift is reported and the shift skipped', () => {
  const plan = planImport({ shifts: [{ id: 'x', date: '2026-07-03', start: 960, end: 30, shift_type: 'Night', break_start: 15, break_end: 45 }], income: [] }, {});
  assert.equal(plan.shifts.length, 0);
  assert.match(plan.skipped[0].reason, /the break must fall inside the shift/);
});

test('runImport writes once and is idempotent on re-run', () => {
  const db = openDb(':memory:');
  const plan = planImport(SRC);
  const first = runImport(db, plan);
  assert.deepEqual([first.created, first.existing], [4, 0]);
  const second = runImport(db, plan);
  assert.deepEqual([second.created, second.existing], [0, 4]);

  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.deepEqual([n('venues'), n('jobs'), n('wage_rates'), n('shifts'), n('money_entries'), n('shift_tags'), n('shift_breaks'), n('locations')], [0, 0, 1, 4, 3, 1, 2, 1], 'no venue or job is made up');
  assert.equal(db.prepare('SELECT SUM(value_cents) AS c FROM money_entries').get().c, 44150);
  const store = shiftStore(db);
  const stored = store.get(store.idForExternalRef('brv8:sh_1'));
  assert.equal(stored.external_ref, 'brv8:sh_1');
  assert.deepEqual(stored.money_entries.map((m) => m.part), ['night']);
  assert.equal(db.prepare('SELECT name FROM locations WHERE id = ?').get(stored.location_id).name, 'Main');
  assert.equal(store.get(store.idForExternalRef('brv8:sh_2')).location_id, null, 'no location in brv8, none here');
  assert.equal(stored.job_id, null);
  // the imported wage history drives the derived wage: 11:00-17:00 less a 30 minute break, at $11.25/hr
  // ...and the $100 of tips gives $18.18 an hour over those 330 paid minutes; tips + wage is $161.88 in all
  assert.deepEqual(store.get(store.idForExternalRef('brv8:sh_2')).derived, {
    paid_minutes: 330, wage_rate_cents: 1125, estimated_wage_cents: 6188,
    tips_cents: 10000, other_income_cents: 0, total_income_cents: 16188,
    tips_per_hour_cents: 1818, other_per_hour_cents: 0, total_per_hour_cents: 2943,
    bartender_count: 1, bartender_minutes: 330, staff_tips_cents: 10000, staff_tips_per_bartender_hour_cents: 1818, has_party: false, party_count: 0,
  });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('backupDb makes an openable copy with the same rows', () => {
  const db = openDb(':memory:');
  runImport(db, planImport(SRC));
  const dir = mkdtempSync(join(tmpdir(), 'bar2000-'));
  const file = backupDb(db, dir);
  assert.ok(existsSync(file));
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM shifts').get().n, 4);
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();
});
