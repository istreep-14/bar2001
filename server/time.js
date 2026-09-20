// Wall-clock time, no timezones. A time is a local 'YYYY-MM-DDTHH:MM' string: exactly the
// clock on the wall where the shift was worked. Such strings sort correctly as text, and an
// overnight shift is simply an end on the next date. Pure; also served to the browser (/time.js)
// so the form and the server's validation share one definition of the overnight rule.

const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;

// Treat the wall-clock fields as if they were UTC: that gives plain calendar arithmetic with no
// zone or daylight-saving surprises.
const ms = (dt) => {
  const m = LOCAL_DT.exec(dt);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
};
const fmt = (t) => new Date(t).toISOString().slice(0, 16);

export function isLocalDateTime(v) {
  return typeof v === 'string' && LOCAL_DT.test(v) && fmt(ms(v)) === v; // round trip rejects 02-30 and 24:00
}

export const dateOf = (dt) => dt.slice(0, 10);
export const timeOf = (dt) => dt.slice(11, 16);

// 'HH:MM' -> minutes after midnight, or null.
export function toMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm ?? '');
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// A local date plus minutes after its midnight; minutes outside 0..1439 roll the date.
export function joinLocal(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  return fmt(Date.UTC(y, m - 1, d, 0, minutes));
}

export const addMinutes = (dt, n) => fmt(ms(dt) + n * 60_000);

// Minutes from `a` to `b`.
export const wallMinutes = (a, b) => Math.round((ms(b) - ms(a)) / 60_000);

// The first moment strictly after `startDt` whose clock reads `hhmm`. An end at or before the
// start therefore means the next day, which is how an overnight shift is entered.
export function resolveEnd(startDt, hhmm) {
  const t = toMinutes(hhmm);
  const end = joinLocal(dateOf(startDt), t);
  return end > startDt ? end : joinLocal(addDays(dateOf(startDt), 1), t);
}

// Which date does a clock time inside or just around a shift fall on? Of the nearby candidates,
// take the one closest to the span [startDt, endDt] (earliest wins a tie). That puts a tip
// period starting at 10:45 AM before an 11:00 AM shift, and one starting at 12:15 AM after an
// overnight shift's midnight, on the right days.
export function resolveNearSpan(startDt, endDt, hhmm) {
  const t = toMinutes(hhmm);
  const base = dateOf(startDt);
  let best = null;
  let bestDistance = Infinity;
  for (const offset of [-1, 0, 1, 2]) {
    const c = joinLocal(addDays(base, offset), t);
    const distance = c < startDt ? wallMinutes(c, startDt) : c > endDt ? wallMinutes(endDt, c) : 0;
    if (distance < bestDistance) {
      best = c;
      bestDistance = distance;
    }
  }
  return best;
}

export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
