// Pure validators: no I/O. Each returns { value, problems }. `value` holds the normalized
// fields that were present; `problems` is a list of "field: message" strings.
// Checks that need the database (foreign keys exist) live in the stores.
import { isLocalDateTime, dateOf, wallMinutes } from './time.js';

export const SHIFT_TYPES = ['day', 'night', 'double'];
export const PARTS = ['day', 'night']; // which half of a double an income entry is for

const MAX_SPAN_MINUTES = 24 * 60;
const MAX_CENTS = 1_000_000_00; // $1,000,000: catches dollars-vs-cents mixups
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const ok = (value) => ({ value });
const bad = (error) => ({ error });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (max, { nullable = false } = {}) => (v) => {
  if (v === null) return nullable ? ok(null) : bad('must not be null');
  if (typeof v !== 'string') return bad('must be a string');
  const t = v.trim();
  if (t.length === 0) return nullable ? ok(null) : bad('must not be empty');
  if (t.length > max) return bad(`must be at most ${max} characters`);
  return ok(t);
};

const uuid = (v) => (typeof v === 'string' && UUID_RE.test(v) ? ok(v.toLowerCase()) : bad('must be a UUID'));

const date = (v) => {
  const m = typeof v === 'string' && DATE_RE.exec(v);
  if (!m) return bad('must be YYYY-MM-DD');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const real = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  return real ? ok(v) : bad('is not a real date');
};

// Local wall-clock time, no zone: 'YYYY-MM-DDTHH:MM'. Anything with a Z or an offset is rejected.
const localTime = (v) => (isLocalDateTime(v) ? ok(v) : bad('must be a local time like 2026-09-18T17:00 (no timezone)'));

const cents = (v) =>
  Number.isInteger(v) && v >= 0 && v <= MAX_CENTS ? ok(v) : bad(`must be a whole number of cents from 0 to ${MAX_CENTS}`);

const breakMinutes = (v) =>
  Number.isInteger(v) && v >= 1 && v <= 1440 ? ok(v) : bad('must be a whole number of minutes from 1 to 1440');

const oneOf = (list) => (v) => (list.includes(v) ? ok(v) : bad(`must be one of: ${list.join(', ')}`));
const nullable = (check) => (v) => (v === null ? ok(null) : check(v));
const flag = (v) => (typeof v === 'boolean' ? ok(v) : bad('must be true or false'));

function run(body, spec, { partial }) {
  if (!isObj(body)) return { value: null, problems: ['body must be a JSON object'] };
  const problems = [];
  const value = {};
  for (const key of Object.keys(body)) if (!(key in spec)) problems.push(`${key}: unknown field`);
  for (const [key, { check, required }] of Object.entries(spec)) {
    if (!(key in body)) {
      if (required && !partial) problems.push(`${key}: required`);
      continue;
    }
    const r = check(body[key]);
    if (r.error) problems.push(`${key}: ${r.error}`);
    else value[key] = r.value;
  }
  return { value, problems };
}

const req = (check) => ({ check, required: true });
const opt = (check) => ({ check, required: false });

export function validateId(v) {
  const r = uuid(v);
  return r.error ? { problems: ['id: must be a UUID'] } : { value: r.value, problems: [] };
}

const VENUE = { name: req(str(200)), notes: opt(str(2000, { nullable: true })), archived: opt(flag) };
const JOB = { venue_id: req(uuid), title: req(str(100)), archived: opt(flag) };
const WAGE_RATE = {
  effective_from: req(date),
  rate_cents: req(cents),
  note: opt(str(500, { nullable: true })),
};
// A locations / other-income-types entry: just a name (unique ignoring case; the list store enforces that).
const LIST_ITEM = { name: req(str(100)), archived: opt(flag) };
// An employee: a name (unique ignoring case; the employees store enforces that), and the fields added since.
const EMPLOYEE = {
  name: req(str(100)),
  role: opt(str(50, { nullable: true })),
  notes: opt(str(2000, { nullable: true })),
  archived: opt(flag),
};
export const validateEmployee = (body, { partial = false } = {}) => run(body, EMPLOYEE, { partial });
export const validateListItem = (body, { partial = false } = {}) => run(body, LIST_ITEM, { partial });
export const validateVenue = (body, { partial = false } = {}) => run(body, VENUE, { partial });
export const validateJob = (body, { partial = false } = {}) => run(body, JOB, { partial });
export const validateWageRate = (body, { partial = false } = {}) => run(body, WAGE_RATE, { partial });

// ---- income ------------------------------------------------------------------------------
// `category_id` is the kind of income (an income_categories row); left out, the store uses Tips.
// `part` is which half of a double the entry is for (day or night), or null for "combined / not
// sure". On a day or night shift the entry belongs to that type, so a null is filled in with it.
const MONEY = {
  category_id: opt(uuid),
  value_cents: req(cents),
  part: opt(nullable(oneOf(PARTS))),
};

export const validateMoneyEntry = (body, { partial = false } = {}) => run(body, MONEY, { partial });

// Does the entry fit the shift's type? Fills in `part`. Returns a problem string or null.
export function settleEntryPart(entry, shiftType) {
  if (shiftType === 'double') {
    if (entry.part === undefined) entry.part = null; // day, night or combined are all fine on a double
    return null;
  }
  if (entry.part == null) {
    entry.part = shiftType;
    return null;
  }
  return entry.part === shiftType ? null : `part: this is a ${shiftType} shift, so its income can't be for ${entry.part}`;
}

function moneyList(v) {
  if (!Array.isArray(v)) return bad('must be an array');
  if (v.length > 50) return bad('must have at most 50 entries');
  const entries = [];
  const ids = new Set();
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    const { id, ...rest } = isObj(item) ? item : {};
    const r = isObj(item) ? validateMoneyEntry(rest) : { problems: ['must be an object'] };
    if (r.problems.length) return bad(`[${i}] ${r.problems.join('; ')}`);
    if (id !== undefined) {
      const idr = uuid(id);
      if (idr.error) return bad(`[${i}] id: ${idr.error}`);
      if (ids.has(idr.value)) return bad(`[${i}] id: duplicate`);
      ids.add(idr.value);
      r.value.id = idr.value;
    }
    entries.push(r.value);
  }
  return ok(entries);
}

const tags = (v) => {
  if (!Array.isArray(v)) return bad('must be an array of strings');
  if (v.length > 20) return bad('must have at most 20 tags');
  const seen = new Set();
  for (const item of v) {
    const r = str(50)(item);
    if (r.error) return bad(`each tag ${r.error}`);
    seen.add(r.value);
  }
  return ok([...seen]);
};

const MAX_BREAKS = 20;
const MAX_STAFF = 30;
const MAX_PARTIES = 10;

// Zero to many breaks. Each is { start_at, end_at } or { minutes }, never both; `null` for the unused
// half is accepted and dropped. Whether they fit the shift is checked in validateShift.
function breakList(v) {
  if (!Array.isArray(v)) return bad('must be an array');
  if (v.length > MAX_BREAKS) return bad(`must have at most ${MAX_BREAKS} breaks`);
  const list = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (!isObj(item)) return bad(`[${i}] must be an object`);
    for (const key of Object.keys(item)) if (!['start_at', 'end_at', 'minutes'].includes(key)) return bad(`[${i}] ${key}: unknown field`);
    const { start_at = null, end_at = null, minutes = null } = item;
    if ((start_at === null) !== (end_at === null)) return bad(`[${i}] give both start_at and end_at, or neither`);
    if (start_at !== null) {
      if (minutes !== null) return bad(`[${i}] give a start and end or a length in minutes, not both`);
      const s = localTime(start_at);
      const e = localTime(end_at);
      if (s.error) return bad(`[${i}] start_at: ${s.error}`);
      if (e.error) return bad(`[${i}] end_at: ${e.error}`);
      list.push({ start_at, end_at });
    } else {
      if (minutes === null) return bad(`[${i}] give a start and end, or a length in minutes`);
      const m = breakMinutes(minutes);
      if (m.error) return bad(`[${i}] minutes: ${m.error}`);
      list.push({ minutes });
    }
  }
  return ok(list);
}

const only = (item, allowed, i) => {
  for (const key of Object.keys(item)) if (!allowed.includes(key)) return bad(`[${i}] ${key}: unknown field`);
  return null;
};

// A pair of optional times: both or neither, each a local time.
function timePair(item, i) {
  const { start_at = null, end_at = null } = item;
  if ((start_at === null) !== (end_at === null)) return { error: `[${i}] give both start_at and end_at, or neither` };
  if (start_at === null) return { start_at: null, end_at: null };
  for (const [key, val] of [['start_at', start_at], ['end_at', end_at]]) {
    const r = localTime(val);
    if (r.error) return { error: `[${i}] ${key}: ${r.error}` };
  }
  return { start_at, end_at };
}

// The other people on a shift: who, and optionally when they worked and the tips they made.
function staffList(v) {
  if (!Array.isArray(v)) return bad('must be an array');
  if (v.length > MAX_STAFF) return bad(`must have at most ${MAX_STAFF} people`);
  const seen = new Set();
  const list = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (!isObj(item)) return bad(`[${i}] must be an object`);
    const unknown = only(item, ['employee_id', 'start_at', 'end_at', 'tips_cents'], i);
    if (unknown) return unknown;
    const id = uuid(item.employee_id);
    if (id.error) return bad(`[${i}] employee_id: ${id.error}`);
    if (seen.has(id.value)) return bad(`[${i}] employee_id: the same person is listed twice`);
    seen.add(id.value);
    const times = timePair(item, i);
    if (times.error) return bad(times.error);
    const tips = item.tips_cents == null ? ok(null) : cents(item.tips_cents);
    if (tips.error) return bad(`[${i}] tips_cents: ${tips.error}`);
    list.push({ employee_id: id.value, ...times, tips_cents: tips.value });
  }
  return ok(list);
}

// Parties: every detail is optional (an empty {} is a party with nothing else said), because that a shift had one
// is what matters.
function partyList(v) {
  if (!Array.isArray(v)) return bad('must be an array');
  if (v.length > MAX_PARTIES) return bad(`must have at most ${MAX_PARTIES} parties`);
  const list = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (!isObj(item)) return bad(`[${i}] must be an object`);
    const unknown = only(item, ['name', 'guests', 'start_at', 'end_at', 'notes'], i);
    if (unknown) return unknown;
    const name = item.name == null ? ok(null) : str(200)(item.name);
    if (name.error) return bad(`[${i}] name: ${name.error}`);
    const notes = item.notes == null ? ok(null) : str(2000)(item.notes);
    if (notes.error) return bad(`[${i}] notes: ${notes.error}`);
    if (item.guests != null && !(Number.isInteger(item.guests) && item.guests >= 1 && item.guests <= 100000)) {
      return bad(`[${i}] guests: must be a whole number from 1 to 100000`);
    }
    const times = timePair(item, i);
    if (times.error) return bad(times.error);
    list.push({ name: name.value, guests: item.guests ?? null, ...times, notes: notes.value });
  }
  return ok(list);
}

const SHIFT = {
  job_id: opt(nullable(uuid)), // the shift form no longer asks for a venue or job
  location_id: opt(nullable(uuid)),
  work_date: opt(date), // defaults to the date the shift starts
  start_at: req(localTime),
  end_at: req(localTime),
  shift_type: req(oneOf(SHIFT_TYPES)),
  breaks: opt(breakList),
  employees: opt(staffList),
  parties: opt(partyList),
  notes: opt(str(2000, { nullable: true })),
  tags: opt(tags),
  money_entries: opt(moneyList),
};
export const SHIFT_FIELDS = Object.keys(SHIFT);

// Full validation of a whole shift document (PUT, or a PATCH merged onto the stored shift).
export function validateShift(body) {
  const { value, problems } = run(body, SHIFT, { partial: false });
  if (problems.length) return { value, problems };

  const span = wallMinutes(value.start_at, value.end_at);
  if (span <= 0) problems.push('end_at: must be after start_at');
  else if (span > MAX_SPAN_MINUTES) problems.push('end_at: shift is longer than 24 hours; check the date');

  // Breaks: each range sits inside the shift, ranges don't overlap, and together they fit in the shift.
  value.breaks ??= [];
  const ranges = [];
  let breakTotal = 0;
  value.breaks.forEach((b, i) => {
    if (b.minutes !== undefined) return void (breakTotal += b.minutes);
    if (b.end_at <= b.start_at) problems.push(`breaks: [${i}] end_at must be after start_at`);
    else if (span > 0 && (b.start_at < value.start_at || b.end_at > value.end_at)) problems.push(`breaks: [${i}] the break must fall inside the shift`);
    else {
      ranges.push(b);
      breakTotal += wallMinutes(b.start_at, b.end_at);
    }
  });
  ranges.sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0));
  for (let i = 1; i < ranges.length; i++) if (ranges[i].start_at < ranges[i - 1].end_at) problems.push('breaks: two breaks overlap');
  if (span > 0 && breakTotal > span) problems.push('breaks: together the breaks are longer than the shift');

  // Staff and party times: an end after its start, and no longer than a day.
  for (const [what, list] of [['employees', value.employees ?? []], ['parties', value.parties ?? []]]) {
    list.forEach((item, i) => {
      if (item.start_at === null) return;
      const minutes = wallMinutes(item.start_at, item.end_at);
      if (minutes <= 0) problems.push(`${what}: [${i}] end_at must be after start_at`);
      else if (minutes > MAX_SPAN_MINUTES) problems.push(`${what}: [${i}] is longer than 24 hours; check the times`);
    });
  }

  (value.money_entries ?? []).forEach((entry, i) => {
    const problem = settleEntryPart(entry, value.shift_type);
    if (problem) problems.push(`money_entries: [${i}] ${problem}`);
  });

  if (!problems.length && !value.work_date) value.work_date = dateOf(value.start_at);
  return { value, problems };
}
