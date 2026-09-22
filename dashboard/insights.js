// What a set of shifts adds up to. Pure and derived, like server/pay.js: nothing is stored, every figure is worked out from
// the shifts on the page each time, so a changed rate or role re-computes all of it. `derive(shift)` is pay.js's
// deriveShift with the wage history and roles filled in (the page provides it), so these totals agree with the table.
import { addDays } from '/time.js';

export const perHour = (cents, minutes) => (minutes > 0 ? Math.round((cents * 60) / minutes) : null);

const blank = () => ({ n: 0, minutes: 0, tips: 0, wage: 0, other: 0, total: 0, wageMissing: 0 });
function add(bucket, d) {
  bucket.n += 1;
  bucket.minutes += d.paid_minutes;
  bucket.tips += d.tips_cents;
  bucket.wage += d.estimated_wage_cents ?? 0;
  bucket.other += d.other_income_cents;
  bucket.total += d.total_income_cents;
  if (d.estimated_wage_cents === null) bucket.wageMissing += 1;
  return bucket;
}
export const tipsPerHour = (b) => perHour(b.tips, b.minutes);
export const totalPerHour = (b) => perHour(b.total, b.minutes);

// Monday of the week a 'YYYY-MM-DD' falls in (weeks run Monday to Sunday, the way a bar week does).
export function mondayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return addDays(date, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
}
export const weekdayIndex = (date) => { const [y, m, d] = date.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }; // 0 = Monday

// Everything the Overview and the form's "how does this compare" lines need, in one pass.
// `shifts` should already be the live ones in the range; `exclude` skips one shift (the one being edited).
export function summarize(shifts, derive, { exclude = null } = {}) {
  const all = blank();
  const byType = { day: blank(), night: blank() };
  const byWeekday = Array.from({ length: 7 }, blank);
  const byLocation = new Map();
  const rows = [];
  for (const s of shifts) {
    if (s.id === exclude || s.deleted_at) continue;
    const d = derive(s);
    rows.push({ s, d });
    add(all, d);
    if (s.shift_type) add(byType[s.shift_type] ?? (byType[s.shift_type] = blank()), d);
    if (s.work_date) add(byWeekday[weekdayIndex(s.work_date)], d);
    if (s.location_id) add(byLocation.get(s.location_id) ?? byLocation.set(s.location_id, blank()).get(s.location_id), d);
  }
  rows.sort((a, b) => (a.s.start_at < b.s.start_at ? -1 : a.s.start_at > b.s.start_at ? 1 : 0));
  return { all, byType, byWeekday, byLocation, rows };
}

// Totals per week (or per month when the range is long), oldest first, with empty periods kept so gaps in work show as gaps.
export function periods(rows, { from, to }) {
  const spanDays = Math.max(1, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000));
  const monthly = spanDays > 26 * 7;
  const keyOf = (date) => (monthly ? date.slice(0, 7) : mondayOf(date));
  const map = new Map();
  const step = (key) => {
    if (!monthly) return addDays(key, 7);
    const [y, m] = key.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };
  const lastKey = keyOf(to);
  for (let key = keyOf(from); key <= lastKey; key = step(key)) map.set(key, { key, ...blank() });
  for (const { s, d } of rows) {
    if (!s.work_date) continue;
    const bucket = map.get(keyOf(s.work_date));
    if (bucket) add(bucket, d);
  }
  return { monthly, buckets: [...map.values()] };
}
