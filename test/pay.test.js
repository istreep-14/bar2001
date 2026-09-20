import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { breakMinutes, paidMinutes, rateOn, deriveShift, hoursText, isBartender, TIPS_CATEGORY_ID } from '../server/pay.js';
import { startApp, shiftDoc } from './helpers.js';

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const CASH = '5dbe47d7-cbe5-4484-85a4-512e48959f67';
const shift = (over = {}) => ({ work_date: '2026-09-18', start_at: '2026-09-18T11:00', end_at: '2026-09-18T17:00', breaks: [], ...over });

test('paid time is the length of the shift minus its breaks, ranges and lengths alike', () => {
  assert.equal(paidMinutes(shift()), 360);
  assert.equal(paidMinutes(shift({ breaks: [{ minutes: 30 }] })), 330);
  assert.equal(paidMinutes(shift({ breaks: [{ start_at: '2026-09-18T14:00', end_at: '2026-09-18T14:45' }, { minutes: 15 }] })), 300);
  assert.equal(breakMinutes([{ minutes: 10 }, { start_at: '2026-09-18T14:00', end_at: '2026-09-18T14:20' }]), 30);
  assert.equal(paidMinutes(shift({ start_at: '2026-09-18T17:00', end_at: '2026-09-19T01:30' })), 510, 'overnight');
  assert.equal(paidMinutes(shift({ breaks: [{ minutes: 9999 }] })), 0, 'never negative');
});

test('the rate is the latest one that has started by the work date', () => {
  const rates = [{ effective_from: '2026-06-01', rate_cents: 1300 }, { effective_from: '2026-01-01', rate_cents: 1125 }, { effective_from: '2027-01-01', rate_cents: 1500 }];
  assert.equal(rateOn(rates, '2025-12-31'), null, 'before the first rate there is none');
  assert.equal(rateOn(rates, '2026-01-01').rate_cents, 1125, 'a rate applies from its own date');
  assert.equal(rateOn(rates, '2026-05-31').rate_cents, 1125);
  assert.equal(rateOn(rates, '2026-06-01').rate_cents, 1300);
  assert.equal(rateOn(rates, '2026-12-31').rate_cents, 1300);
  assert.equal(rateOn(rates, '2030-01-01').rate_cents, 1500);
  assert.equal(rateOn([], '2026-01-01'), null);
});

test('a shift earns paid hours times the rate, to the nearest cent; no rate means no estimate', () => {
  const rates = [{ effective_from: '2026-01-01', rate_cents: 1125 }];
  assert.deepEqual(pick(deriveShift(shift(), rates), ['paid_minutes', 'wage_rate_cents', 'estimated_wage_cents']), { paid_minutes: 360, wage_rate_cents: 1125, estimated_wage_cents: 6750 });
  assert.equal(deriveShift(shift({ breaks: [{ minutes: 30 }] }), rates).estimated_wage_cents, 6188, '5.5h x $11.25 = $61.875, rounded up');
  assert.equal(deriveShift(shift({ breaks: [{ minutes: 1 }] }), [{ effective_from: '2026-01-01', rate_cents: 1000 }]).estimated_wage_cents, 5983, '359 min x $10 = $59.8333');
  assert.deepEqual(pick(deriveShift(shift({ work_date: '2025-06-01' }), rates), ['paid_minutes', 'wage_rate_cents', 'estimated_wage_cents']), { paid_minutes: 360, wage_rate_cents: null, estimated_wage_cents: null });
  assert.equal(deriveShift(shift({ work_date: '2026-09-19', start_at: '2026-09-18T17:00', end_at: '2026-09-19T01:00' }), rates).wage_rate_cents, 1125, 'the rate follows the work date, not the start date');
});

test('tips, other income and the total are added up from the entries, and each has a per-hour figure', () => {
  const rates = [{ effective_from: '2026-01-01', rate_cents: 1000 }];
  const money_entries = [
    { category_id: TIPS_CATEGORY_ID, value_cents: 21000 }, { category_id: TIPS_CATEGORY_ID, value_cents: 3050 }, // tips: $240.50
    { category_id: CASH, value_cents: 2500 }, { category_id: '303e3424-cc87-478d-b056-986e822a159c', value_cents: 4000 }, // other: $65.00
  ];
  // 6 paid hours: wage $60.00, so total = 240.50 + 60.00 + 65.00 = $365.50
  const d = deriveShift(shift({ money_entries }), rates);
  assert.deepEqual([d.tips_cents, d.other_income_cents, d.estimated_wage_cents, d.total_income_cents], [24050, 6500, 6000, 36550]);
  assert.deepEqual([d.tips_per_hour_cents, d.other_per_hour_cents, d.total_per_hour_cents], [4008, 1083, 6092], '$40.083, $10.833 and $60.917 an hour, to the cent');
  assert.equal(d.wage_rate_cents, 1000, 'wage per hour is just the rate');

  // an entry with no type counts as tips; no entries is zero, not null
  assert.equal(deriveShift(shift({ money_entries: [{ value_cents: 500 }] }), []).tips_cents, 500);
  const none = deriveShift(shift(), rates);
  assert.deepEqual([none.tips_cents, none.other_income_cents, none.total_income_cents, none.tips_per_hour_cents], [0, 0, 6000, 0], 'a shift with no income entries earns just its wage');

  // with no rate the total is what was actually entered, and the wage stays null rather than 0
  const unpaid = deriveShift(shift({ work_date: '2025-06-01', money_entries }), rates);
  assert.deepEqual([unpaid.estimated_wage_cents, unpaid.total_income_cents, unpaid.total_per_hour_cents], [null, 30550, 5092]);

  // no paid time (all break) means no per-hour figures, and no dividing by zero
  const zero = deriveShift(shift({ breaks: [{ minutes: 360 }], money_entries }), rates);
  assert.deepEqual([zero.paid_minutes, zero.tips_per_hour_cents, zero.other_per_hour_cents, zero.total_per_hour_cents], [0, null, null, null]);
  assert.equal(zero.total_income_cents, 30550, 'the amounts are still there');
});

test('who counts as a bartender: a blank role, or Bartender in any case', () => {
  for (const role of [null, undefined, '', 'Bartender', 'bartender', ' BARTENDER ']) assert.equal(isBartender(role), true, String(role));
  for (const role of ['Barback', 'Server', 'Head bartender', 'Bouncer']) assert.equal(isBartender(role), false, role);
});

test('staffing: you plus the bartenders on the shift, their hours, and the tips made by everyone', () => {
  const roles = { a: 'Bartender', b: null, c: 'Barback' };
  const roleOf = (id) => roles[id] ?? null;
  const staff = [
    { employee_id: 'a', start_at: '2026-09-18T17:00', end_at: '2026-09-18T23:00', tips_cents: 15000 }, // 6h
    { employee_id: 'b', start_at: null, end_at: null, tips_cents: null },                               // no times, no tips: counted, no hours
    { employee_id: 'c', start_at: '2026-09-18T17:00', end_at: '2026-09-19T01:00', tips_cents: 5000 },   // barback: tips only
  ];
  // you: 11:00-17:00 less 30 = 5.5h (330 min), $120 tips
  const d = deriveShift(shift({ breaks: [{ minutes: 30 }], money_entries: [{ value_cents: 12000 }], employees: staff }), [], roleOf);
  assert.deepEqual([d.bartender_count, d.bartender_minutes], [3, 330 + 360], 'you, a and b; b has no hours yet');
  assert.equal(d.staff_tips_cents, 12000 + 15000 + 5000, 'a barback\'s tips count towards the shift');
  assert.equal(d.staff_tips_per_bartender_hour_cents, Math.round((32000 * 60) / 690), '$27.83');

  const alone = deriveShift(shift({ money_entries: [{ value_cents: 12000 }] }), []);
  assert.deepEqual([alone.bartender_count, alone.bartender_minutes, alone.staff_tips_cents], [1, 360, 12000], 'with nobody listed it is just you');
  assert.deepEqual(pick(deriveShift(shift({ employees: staff }), [], () => 'Barback'), ['bartender_count', 'bartender_minutes']), { bartender_count: 1, bartender_minutes: 360 }, 'nobody else is a bartender');
  const noHours = deriveShift(shift({ breaks: [{ minutes: 360 }], employees: [{ employee_id: 'a', start_at: null, end_at: null, tips_cents: 900 }] }), [], roleOf);
  assert.equal(noHours.staff_tips_per_bartender_hour_cents, null, 'no bartender hours, no per-hour figure');
});

test('a party is a flag and a count', () => {
  assert.deepEqual(pick(deriveShift(shift(), []), ['has_party', 'party_count']), { has_party: false, party_count: 0 });
  assert.deepEqual(pick(deriveShift(shift({ parties: [{ name: null }] }), []), ['has_party', 'party_count']), { has_party: true, party_count: 1 }, 'a party with no details still counts');
  assert.deepEqual(pick(deriveShift(shift({ parties: [{}, { name: 'Smith' }] }), []), ['has_party', 'party_count']), { has_party: true, party_count: 2 });
});

test('hoursText', () => {
  assert.deepEqual([hoursText(0), hoursText(45), hoursText(60), hoursText(570)], ['0m', '45m', '1h', '9h 30m']);
});

test('every shift the API returns carries its derived numbers, and they follow the wage history live', () => {
  return startApp().then(async (app) => {
    try {
      const id = randomUUID();
      const put = await app.call('PUT', `/shifts/${id}`, shiftDoc(undefined, { start_at: '2026-09-18T11:00', end_at: '2026-09-18T21:30', shift_type: 'double', breaks: [{ minutes: 30 }] }));
      assert.deepEqual(pick(put.body.derived, ['paid_minutes', 'wage_rate_cents', 'estimated_wage_cents']), { paid_minutes: 600, wage_rate_cents: null, estimated_wage_cents: null }, 'no wage set yet');

      const first = (await app.call('POST', '/wage-rates', { effective_from: '2026-01-01', rate_cents: 1000 })).body;
      assert.deepEqual(pick((await app.call('GET', `/shifts/${id}`)).body.derived, ['paid_minutes', 'wage_rate_cents', 'estimated_wage_cents']), { paid_minutes: 600, wage_rate_cents: 1000, estimated_wage_cents: 10000 });
      assert.equal((await app.call('GET', '/shifts')).body.shifts[0].derived.estimated_wage_cents, 10000, 'lists too');
      assert.equal((await app.call('GET', '/export')).body.shifts[0].derived.estimated_wage_cents, 10000, 'and the export');

      await app.call('PATCH', `/wage-rates/${first.id}`, { rate_cents: 1250 });
      assert.equal((await app.call('GET', `/shifts/${id}`)).body.derived.estimated_wage_cents, 12500, 'a changed rate re-prices existing shifts');
      await app.call('POST', '/wage-rates', { effective_from: '2026-09-18', rate_cents: 1500 });
      assert.equal((await app.call('GET', `/shifts/${id}`)).body.derived.estimated_wage_cents, 15000, 'a newer rate applies from its date');

      // derived is never stored and never accepted
      const cols = app.db.prepare('PRAGMA table_info(shifts)').all().map((c) => c.name);
      assert.ok(!cols.some((c) => /wage|paid|derived/.test(c)));
      const bad = await app.call('PUT', `/shifts/${id}`, { ...shiftDoc(undefined), derived: { estimated_wage_cents: 1 } });
      assert.equal(bad.status, 400);
      assert.match(bad.body.problems.join(), /derived: unknown field/);
      const merged = await app.call('PATCH', `/shifts/${id}`, { notes: 'x' });
      assert.equal(merged.status, 200, 'a patch still works with derived in the stored shift');
    } finally {
      await app.close();
    }
  });
});

test('the API adds up a real shift: tips per hour, other per hour and total per hour', () => {
  return startApp().then(async (app) => {
    try {
      const cash = (await app.call('POST', '/income-categories', { name: 'Cash' })).body;
      await app.call('POST', '/wage-rates', { effective_from: '2026-01-01', rate_cents: 1300 });
      const put = await app.call('PUT', `/shifts/${randomUUID()}`, shiftDoc(undefined, {
        start_at: '2026-09-18T17:00', end_at: '2026-09-19T01:30', shift_type: 'night', breaks: [{ minutes: 30 }],
        money_entries: [{ value_cents: 28000 }, { value_cents: 8000, category_id: cash.id }],
      }));
      // 8 paid hours: wage $104.00, tips $280.00, other $80.00, total $464.00
      assert.deepEqual(put.body.derived, {
        paid_minutes: 480, wage_rate_cents: 1300, estimated_wage_cents: 10400,
        tips_cents: 28000, other_income_cents: 8000, total_income_cents: 46400,
        tips_per_hour_cents: 3500, other_per_hour_cents: 1000, total_per_hour_cents: 5800,
        bartender_count: 1, bartender_minutes: 480, staff_tips_cents: 28000, staff_tips_per_bartender_hour_cents: 3500, has_party: false, party_count: 0,
      });
    } finally {
      await app.close();
    }
  });
});
