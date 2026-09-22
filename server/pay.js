// What a shift earned, worked out from its times, its income entries and your hourly wage history. Pure and
// derived: nothing here is ever stored, and it is recomputed whenever a shift or a rate is read.
// Shared with the browser (served at /pay.js), so the server's API and the page always agree.
//
//   paid time  = the shift's length minus its breaks (breaks are unpaid); this is "time worked"
//   rate       = the wage_rates row with the latest effective_from on or before the shift's work_date
//   wage       = paid time x rate, rounded to the nearest cent (null when no rate applies yet)
//   tips       = the shift's tips entries added up; other = its other-income entries added up
//   total      = tips + wage (when there is one) + other
//   per hour   = an amount over paid time, to the nearest cent (null when there is no paid time)
//   staffing   = you plus the employees on the shift whose role is Bartender (or blank): how many, and their hours
//                (yours are paid time; an employee's is their own start to end, when given); and the tips made by
//                everyone on the shift (yours plus each employee's, where entered)
//   party      = whether the shift has any party record (the yes/no flag), and how many
import { wallMinutes } from './time.js';

// The built-in Tips income type (a fixed id, so a shift's entries can be sorted into tips and other without a lookup).
export const TIPS_CATEGORY_ID = '00000000-0000-4000-8000-000000000001';

export function breakMinutes(breaks) {
  return breaks.reduce((sum, b) => sum + (b.minutes ?? wallMinutes(b.start_at, b.end_at)), 0);
}

export const paidMinutes = ({ start_at, end_at, breaks = [] }) =>
  start_at && end_at ? Math.max(0, wallMinutes(start_at, end_at) - breakMinutes(breaks)) : 0;

// `rates` is [{ effective_from: 'YYYY-MM-DD', rate_cents }] in any order. Null before the first rate.
export function rateOn(rates, workDate) {
  let best = null;
  for (const r of rates) if (r.effective_from <= workDate && (!best || r.effective_from > best.effective_from)) best = r;
  return best;
}

// No roles, or "Bartender" among them, counts as a bartender: most of the people you list are, and it means
// nothing needs setting up first.
export const isBartender = (roles) => !roles?.length || roles.some((r) => r.trim().toLowerCase() === 'bartender');

const perHour = (cents, minutes) => (minutes > 0 ? Math.round((cents * 60) / minutes) : null);

// `shift` may have work_date, start_at, end_at (all optional; paid time and wage are 0/null without them),
// and optionally breaks[], money_entries[] ({category_id, value_cents}), employees[] ({employee_id, start_at,
// end_at, tips_cents}) and parties[]. `rolesOf(employee_id)` gives an employee's roles[].
export function deriveShift(shift, rates, rolesOf = () => []) {
  const minutes = paidMinutes(shift);
  const rate = shift.work_date ? rateOn(rates, shift.work_date) : null;
  const wage = rate ? Math.round((minutes * rate.rate_cents) / 60) : null;
  let tips = 0;
  let other = 0;
  for (const m of shift.money_entries ?? []) {
    if (!m.category_id || m.category_id === TIPS_CATEGORY_ID) tips += m.value_cents;
    else other += m.value_cents;
  }
  const total = tips + other + (wage ?? 0);

  let bartenders = 1; // you
  let bartenderMinutes = minutes;
  let staffTips = tips;
  for (const e of shift.employees ?? []) {
    staffTips += e.tips_cents ?? 0;
    if (!isBartender(rolesOf(e.employee_id))) continue;
    bartenders += 1;
    if (e.start_at) bartenderMinutes += wallMinutes(e.start_at, e.end_at);
  }
  return {
    paid_minutes: minutes,
    wage_rate_cents: rate?.rate_cents ?? null,
    estimated_wage_cents: wage,
    tips_cents: tips,
    other_income_cents: other,
    total_income_cents: total,
    tips_per_hour_cents: perHour(tips, minutes),
    other_per_hour_cents: perHour(other, minutes),
    total_per_hour_cents: perHour(total, minutes),
    bartender_count: bartenders,
    bartender_minutes: bartenderMinutes,
    staff_tips_cents: staffTips,
    staff_tips_per_bartender_hour_cents: perHour(staffTips, bartenderMinutes),
    has_party: (shift.parties ?? []).length > 0,
    party_count: (shift.parties ?? []).length,
  };
}

export function hoursText(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
