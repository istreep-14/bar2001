import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLocalDateTime, toMinutes, addDays, joinLocal, addMinutes, wallMinutes, resolveEnd, resolveNearSpan, dateOf, timeOf,
} from '../server/time.js';
import { validateShift, validateMoneyEntry, validateVenue, validateListItem, validateEmployee } from '../server/validate.js';

const JOB = '3f2b1c9e-8d4a-4b6e-9a7c-1d2e3f405162';
const doc = (over = {}) => ({ job_id: JOB, start_at: '2026-09-18T11:00', end_at: '2026-09-18T21:30', shift_type: 'double', ...over });
const problems = (d) => validateShift(d).problems.join(' | ');

// ---- wall-clock helpers --------------------------------------------------------------
test('isLocalDateTime accepts wall-clock times and rejects zones and impossible dates', () => {
  assert.equal(isLocalDateTime('2026-09-18T17:00'), true);
  for (const bad of ['2026-09-18T17:00Z', '2026-09-18T17:00:00', '2026-09-18T17:00-04:00', '2026-09-18 17:00', '2026-02-30T10:00', '2026-09-18T24:00', '2026-09-18T17:60', 5, null]) {
    assert.equal(isLocalDateTime(bad), false, String(bad));
  }
});

test('toMinutes, addDays, joinLocal, wallMinutes, addMinutes', () => {
  assert.equal(toMinutes('17:45'), 1065);
  assert.equal(toMinutes('24:00'), null);
  assert.equal(toMinutes('5:45'), null);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(joinLocal('2026-09-18', 1470), '2026-09-19T00:30');
  assert.equal(wallMinutes('2026-09-18T17:00', '2026-09-19T01:00'), 480);
  assert.equal(wallMinutes('2026-03-08T01:00', '2026-03-08T04:00'), 180); // no daylight-saving math
  assert.equal(addMinutes('2026-09-18T23:59', 2), '2026-09-19T00:01');
  assert.deepEqual([dateOf('2026-09-18T17:45'), timeOf('2026-09-18T17:45')], ['2026-09-18', '17:45']);
});

test('resolveEnd: an end at or before the start is the next day', () => {
  assert.equal(resolveEnd('2026-09-18T11:00', '21:30'), '2026-09-18T21:30');
  assert.equal(resolveEnd('2026-09-18T17:00', '01:00'), '2026-09-19T01:00');
  assert.equal(resolveEnd('2026-09-18T17:00', '17:00'), '2026-09-19T17:00');
});

test('resolveNearSpan puts a clock time on the date nearest the shift', () => {
  assert.equal(resolveNearSpan('2026-09-18T11:00', '2026-09-18T21:30', '15:00'), '2026-09-18T15:00');
  assert.equal(resolveNearSpan('2026-09-18T17:00', '2026-09-19T01:00', '00:15'), '2026-09-19T00:15'); // an after-midnight break
  assert.equal(resolveNearSpan('2026-09-18T17:00', '2026-09-19T01:00', '20:00'), '2026-09-18T20:00');
  assert.equal(resolveNearSpan('2026-09-18T08:00', '2026-09-19T00:00', '21:00'), '2026-09-18T21:00'); // a 16-hour shift
});

// ---- shifts ------------------------------------------------------------------------------
test('a shift needs a type: day, night or double', () => {
  for (const type of ['day', 'night', 'double']) assert.deepEqual(validateShift(doc({ shift_type: type })).problems, [], type);
  const omitted = doc();
  delete omitted.shift_type;
  assert.match(problems(omitted), /shift_type: required/);
  assert.match(problems(doc({ shift_type: 'mid' })), /shift_type: must be one of: day, night, double/);
  assert.match(problems(doc({ shift_type: null })), /shift_type: must be one of/);
});

test('tip periods and timezones no longer exist', () => {
  assert.match(problems(doc({ tip_periods: [] })), /tip_periods: unknown field/);
  assert.match(problems(doc({ tz: 'America/New_York' })), /tz: unknown field/);
  assert.match(problems(doc({ start_at: '2026-09-18T15:00:00Z' })), /start_at: must be a local time/);
  assert.match(problems(doc({ end_at: '2026-09-18T21:30-04:00' })), /end_at: must be a local time/);
});

test('an overnight shift is just an end on the next date; work_date defaults to the start date', () => {
  const r = validateShift(doc({ start_at: '2026-09-18T17:00', end_at: '2026-09-19T01:00', shift_type: 'night' }));
  assert.deepEqual(r.problems, []);
  assert.equal(r.value.work_date, '2026-09-18');
  assert.equal(validateShift(doc({ work_date: '2026-09-17' })).value.work_date, '2026-09-17');
});

test('end must be after start, and a shift is at most 24 hours', () => {
  assert.match(problems(doc({ end_at: '2026-09-18T11:00' })), /end_at: must be after start_at/);
  assert.match(problems(doc({ end_at: '2026-09-18T09:00' })), /must be after start_at/);
  assert.match(problems(doc({ end_at: '2026-09-20T11:00' })), /longer than 24 hours/);
});

// ---- breaks ----------------------------------------------------------------------------
const R = (s, e) => ({ start_at: `2026-09-18T${s}`, end_at: `2026-09-18T${e}` });

test('a shift can have no breaks, one, or many; each a range or just minutes', () => {
  const none = validateShift(doc());
  assert.deepEqual([none.problems, none.value.breaks], [[], []]);
  const one = validateShift(doc({ breaks: [R('15:00', '15:30')] }));
  assert.deepEqual([one.problems, one.value.breaks], [[], [R('15:00', '15:30')]]);
  const many = validateShift(doc({ breaks: [R('13:00', '13:15'), { minutes: 30 }, R('18:00', '18:20'), { start_at: '2026-09-18T19:00', end_at: '2026-09-18T19:10', minutes: null }] }));
  assert.deepEqual(many.problems, []);
  assert.deepEqual(many.value.breaks[1], { minutes: 30 });
  assert.deepEqual(many.value.breaks[3], { start_at: '2026-09-18T19:00', end_at: '2026-09-18T19:10' }, 'a null half is dropped');
  assert.match(problems(doc({ breaks: Array.from({ length: 21 }, () => ({ minutes: 1 })) })), /at most 20 breaks/);
});

test('a break is a range or a length, never both or neither, and a range needs both ends', () => {
  assert.match(problems(doc({ breaks: [{ ...R('15:00', '15:30'), minutes: 30 }] })), /a start and end or a length in minutes, not both/);
  assert.match(problems(doc({ breaks: [{}] })), /give a start and end, or a length in minutes/);
  assert.match(problems(doc({ breaks: [{ start_at: '2026-09-18T15:00' }] })), /both start_at and end_at, or neither/);
  assert.match(problems(doc({ breaks: [{ end_at: '2026-09-18T15:30' }] })), /both start_at and end_at, or neither/);
  assert.match(problems(doc({ breaks: [R('15:30', '15:00')] })), /\[0\] end_at must be after start_at/);
  assert.match(problems(doc({ breaks: [R('15:00', '15:00')] })), /must be after start_at/);
  assert.match(problems(doc({ breaks: [{ start_at: '2026-09-18T15:00Z', end_at: '2026-09-18T16:00Z' }] })), /must be a local time/);
  assert.match(problems(doc({ breaks: [{ minutes: 20, length: 5 }] })), /length: unknown field/);
  assert.match(problems(doc({ breaks: 'lunch' })), /breaks: must be an array/);
  assert.match(problems(doc({ break_minutes: 30 })), /break_minutes: unknown field/, 'the old single-break fields are gone');
});

test('breaks must sit inside the shift, not overlap, and fit within it together', () => {
  assert.match(problems(doc({ breaks: [R('10:30', '11:15')] })), /must fall inside the shift/);
  assert.match(problems(doc({ breaks: [R('21:00', '22:00')] })), /must fall inside the shift/);
  assert.deepEqual(validateShift(doc({ breaks: [R('11:00', '21:30')] })).problems, []); // touching the edges is fine
  assert.match(problems(doc({ breaks: [{ minutes: 700 }] })), /together the breaks are longer than the shift/);
  assert.match(problems(doc({ breaks: [{ minutes: 0 }] })), /whole number of minutes from 1 to 1440/);
  assert.match(problems(doc({ breaks: [{ minutes: 30.5 }] })), /whole number of minutes/);
  assert.match(problems(doc({ breaks: [R('15:00', '16:00'), R('15:30', '16:30')] })), /two breaks overlap/);
  assert.deepEqual(validateShift(doc({ breaks: [R('16:00', '16:30'), R('15:00', '16:00')] })).problems, [], 'back to back is not an overlap, and order does not matter');
  assert.deepEqual(validateShift(doc({ breaks: [R('11:00', '16:00'), R('17:00', '21:00'), { minutes: 90 }] })).problems, [], '300 + 240 + 90 minutes is exactly the 630-minute shift');
  assert.match(problems(doc({ breaks: [R('11:00', '16:00'), R('17:00', '21:00'), { minutes: 100 }] })), /together the breaks are longer than the shift/, 'ranges and lengths add up');
  // an overnight break lands on the next date
  const late = doc({ start_at: '2026-09-18T17:00', end_at: '2026-09-19T01:00', shift_type: 'night', breaks: [{ start_at: '2026-09-19T00:15', end_at: '2026-09-19T00:45' }] });
  assert.deepEqual(validateShift(late).problems, []);
});

// ---- location, employees, parties, job ---------------------------------------------------
const ANA = '5dbe47d7-cbe5-4484-85a4-512e48959f67';
const BEN = '303e3424-cc87-478d-b056-986e822a159c';

test('location is an id and a job is optional', () => {
  assert.deepEqual(validateShift(doc({ location_id: ANA })).problems, []);
  assert.deepEqual(validateShift(doc({ location_id: null, job_id: null })).problems, []);
  assert.match(problems(doc({ location_id: 'Main Bar' })), /location_id: must be a UUID/);
  assert.match(problems(doc({ section: 'Main' })), /section: unknown field/, 'section became location');
  assert.match(problems(doc({ coworker_ids: [ANA] })), /coworker_ids: unknown field/, 'coworkers became employees');
});

test('employees on a shift: who, and optionally their times and the tips they made', () => {
  const none = validateShift(doc());
  assert.deepEqual(none.value.employees ?? [], []);
  const r = validateShift(doc({ employees: [
    { employee_id: ANA },
    { employee_id: BEN.toUpperCase(), start_at: '2026-09-18T12:00', end_at: '2026-09-18T20:00', tips_cents: 12050 },
    ] }));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.value.employees, [
    { employee_id: ANA, start_at: null, end_at: null, tips_cents: null },
    { employee_id: BEN, start_at: '2026-09-18T12:00', end_at: '2026-09-18T20:00', tips_cents: 12050 },
  ], 'ids are lower-cased and every optional detail is present, as null');
  assert.deepEqual(validateShift(doc({ employees: [{ employee_id: ANA, start_at: null, end_at: null, tips_cents: null }] })).problems, []);
  assert.match(problems(doc({ employees: [{ employee_id: ANA }, { employee_id: ANA.toUpperCase() }] })), /the same person is listed twice/);
  assert.match(problems(doc({ employees: [{ employee_id: 'Ana' }] })), /employee_id: must be a UUID/);
  assert.match(problems(doc({ employees: [{}] })), /employee_id: must be a UUID/);
  assert.match(problems(doc({ employees: [{ employee_id: ANA, start_at: '2026-09-18T12:00' }] })), /both start_at and end_at, or neither/);
  assert.match(problems(doc({ employees: [{ employee_id: ANA, start_at: '2026-09-18T20:00', end_at: '2026-09-18T12:00' }] })), /employees: \[0\] end_at must be after start_at/);
  assert.match(problems(doc({ employees: [{ employee_id: ANA, start_at: '2026-09-18T01:00', end_at: '2026-09-19T12:00' }] })), /longer than 24 hours/);
  assert.match(problems(doc({ employees: [{ employee_id: ANA, start_at: '2026-09-18T12:00Z', end_at: '2026-09-18T20:00Z' }] })), /must be a local time/);
  assert.match(problems(doc({ employees: [{ employee_id: ANA, tips_cents: -5 }] })), /tips_cents: must be a whole number of cents/);
  assert.match(problems(doc({ employees: [{ employee_id: ANA, hours: 6 }] })), /hours: unknown field/);
  assert.match(problems(doc({ employees: 'Ana' })), /employees: must be an array/);
  assert.match(problems(doc({ employees: Array.from({ length: 31 }, (_, i) => ({ employee_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })) })), /at most 30/);
  // their times may fall outside yours: someone can come in early or stay after you leave
  assert.deepEqual(validateShift(doc({ employees: [{ employee_id: ANA, start_at: '2026-09-18T09:00', end_at: '2026-09-18T23:00' }] })).problems, []);
});

test('a party is a yes/no that can carry details, all optional', () => {
  const empty = validateShift(doc({ parties: [{}] }));
  assert.deepEqual([empty.problems, empty.value.parties], [[], [{ name: null, guests: null, start_at: null, end_at: null, notes: null }]], 'an empty party is a party');
  const full = validateShift(doc({ parties: [{ name: ' Smith 40th ', guests: 40, start_at: '2026-09-18T19:00', end_at: '2026-09-18T22:00', notes: 'Open bar til 9' }, {}] }));
  assert.deepEqual(full.problems, []);
  assert.equal(full.value.parties[0].name, 'Smith 40th');
  assert.equal(full.value.parties.length, 2, 'more than one is fine');
  assert.deepEqual(validateShift(doc()).value.parties ?? [], []);
  assert.match(problems(doc({ parties: [{ guests: 0 }] })), /guests: must be a whole number from 1 to 100000/);
  assert.match(problems(doc({ parties: [{ guests: 4.5 }] })), /guests: must be a whole number/);
  assert.match(problems(doc({ parties: [{ name: '   ' }] })), /name: must not be empty/);
  assert.match(problems(doc({ parties: [{ start_at: '2026-09-18T19:00' }] })), /both start_at and end_at, or neither/);
  assert.match(problems(doc({ parties: [{ start_at: '2026-09-18T22:00', end_at: '2026-09-18T19:00' }] })), /parties: \[0\] end_at must be after start_at/);
  assert.match(problems(doc({ parties: [{ venue: 'x' }] })), /venue: unknown field/);
  assert.match(problems(doc({ parties: Array.from({ length: 11 }, () => ({})) })), /at most 10 parties/);
});

test('an employee record: a name, a role and notes', () => {
  assert.deepEqual(validateEmployee({ name: '  Ana  ', role: 'Bartender', notes: null }).value, { name: 'Ana', role: 'Bartender', notes: null });
  assert.deepEqual(validateEmployee({ name: 'Ana' }).value, { name: 'Ana' });
  assert.match(validateEmployee({}).problems.join(), /name: required/);
  assert.deepEqual(validateEmployee({ name: 'Ana', role: '  ' }).value, { name: 'Ana', role: null }, 'a blank role is no role');
  assert.match(validateEmployee({ name: 'Ana', role: 'x'.repeat(51) }).problems.join(), /role: must be at most 50/);
  assert.match(validateEmployee({ name: 'Ana', phone: '1' }).problems.join(), /phone: unknown field/);
  assert.deepEqual(validateEmployee({ role: null }, { partial: true }).value, { role: null }, 'a role can be cleared');
});

test('list entries are just a name', () => {
  assert.deepEqual(validateListItem({ name: '  Main Bar ' }).value, { name: 'Main Bar' });
  assert.match(validateListItem({}).problems.join(), /name: required/);
  assert.match(validateListItem({ name: '   ' }).problems.join(), /name: must not be empty/);
  assert.match(validateListItem({ name: 'x'.repeat(101) }).problems.join(), /at most 100/);
  assert.match(validateListItem({ name: 'A', colour: 'red' }).problems.join(), /colour: unknown field/);
  assert.deepEqual(validateListItem({ archived: true }, { partial: true }).value, { archived: true });
});

// ---- tips ------------------------------------------------------------------------------
test('income: the type is optional (the store makes it tips), value is whole cents, parts are day or night', () => {
  assert.deepEqual(validateMoneyEntry({ value_cents: 21000 }).value, { value_cents: 21000 });
  const type = '5dbe47d7-cbe5-4484-85a4-512e48959f67';
  assert.deepEqual(validateMoneyEntry({ value_cents: 21000, category_id: type }).value, { value_cents: 21000, category_id: type });
  assert.match(validateMoneyEntry({ value_cents: 12.5 }).problems.join(), /whole number of cents/);
  assert.match(validateMoneyEntry({ value_cents: -1 }).problems.join(), /whole number of cents/);
  assert.match(validateMoneyEntry({ category_id: 'wage', value_cents: 100 }).problems.join(), /category_id: must be a UUID/);
  assert.match(validateMoneyEntry({ category: 'tips', value_cents: 100 }).problems.join(), /category: unknown field/);
  assert.match(validateMoneyEntry({ value_cents: 100, tip_period: 'day' }).problems.join(), /tip_period: unknown field/);
  assert.match(validateMoneyEntry({ value_cents: 100, part: 'double' }).problems.join(), /part: must be one of: day, night/);
  assert.deepEqual(validateMoneyEntry({ value_cents: 100, part: null }).problems, []);
});

test('on a double, tips are for the day, the night, or combined', () => {
  const r = validateShift(doc({ money_entries: [{ value_cents: 21000, part: 'day' }, { value_cents: 34550, part: 'night' }, { value_cents: 1000, part: null }, { value_cents: 5 }] }));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.value.money_entries.map((m) => m.part), ['day', 'night', null, null]);
});

test('on a day or night shift, tips belong to that type automatically, and cannot be for the other', () => {
  const night = validateShift(doc({ shift_type: 'night', money_entries: [{ value_cents: 100 }, { value_cents: 200, part: null }, { value_cents: 300, part: 'night' }] }));
  assert.deepEqual(night.problems, []);
  assert.deepEqual(night.value.money_entries.map((m) => m.part), ['night', 'night', 'night']);
  assert.match(problems(doc({ shift_type: 'night', money_entries: [{ value_cents: 1, part: 'day' }] })), /this is a night shift, so its income can't be for day/);
  assert.match(problems(doc({ shift_type: 'day', money_entries: [{ value_cents: 1, part: 'night' }] })), /this is a day shift/);
});

test('entry ids must be unique UUIDs; tags are de-duplicated; unknown fields rejected', () => {
  const dup = validateShift(doc({ money_entries: [{ id: JOB, value_cents: 1 }, { id: JOB, value_cents: 2 }] }));
  assert.match(dup.problems.join(), /duplicate/);
  assert.deepEqual(validateShift(doc({ tags: ['busy', 'busy', ' slow '] })).value.tags, ['busy', 'slow']);
  assert.match(problems(doc({ hours: 8 })), /hours: unknown field/);
  assert.deepEqual(validateShift([]).problems, ['body must be a JSON object']);
});

test('partial validation allows a subset but still rejects bad values', () => {
  assert.deepEqual(validateVenue({ archived: true }, { partial: true }).problems, []);
  assert.match(validateVenue({}, { partial: false }).problems.join(), /name: required/);
  assert.match(validateVenue({ name: '' }, { partial: true }).problems.join(), /must not be empty/);
});
