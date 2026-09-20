// A month calendar that shows the shifts you have logged, in two sizes:
//   pick    the Date page of the shift form: tap a day to set the shift's date. Days that already hold a shift carry its
//           type (D, N or D+N) and tips; arrow keys move between days.
//   browse  the Calendar page: each shift is a chip (type, hours, income) that opens it, a day's shade is how much it
//           earned relative to the month's best, and an empty day starts a new shift on that date.
// Weeks run Monday to Sunday. Dates are 'YYYY-MM-DD' strings handled as calendar arithmetic, never through the local timezone.
import { h, svg, css, usd0, hours1, tiles, TYPE_LETTER, TYPE_NAME, monthName, weekdayName, shortDate } from '/viz.js';
import { addDays } from '/time.js';
import { tipsPerHour, totalPerHour, weekdayIndex } from '/insights.js';

const pad = (n) => String(n).padStart(2, '0');
export const todayText = () => new Date().toLocaleDateString('en-CA');
const chevron = (dir) => svg('svg', { viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  svg('path', { d: dir < 0 ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6' }));

// `selected()` is the date the form holds; `exclude()` the id of the shift being edited (it doesn't count as "already logged").
export function createCalendar({ mode, data, derive, selected = () => null, exclude = () => null, onPick, onOpen, onNew }) {
  const today = todayText();
  let view = { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 };
  const title = h('h3', { class: 'caltitle', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month' }, chevron(-1));
  const next = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month' }, chevron(1));
  const now = h('button', { type: 'button', class: 'linkbtn' }, 'Jump to today');
  const grid = h('div', { class: 'calgrid' });
  const foot = h('div', { class: 'calfoot' });
  const key = h('ul', { class: 'legend calkey' },
    ...['day', 'night', 'double'].map((t) => h('li', null, h('i', { class: 'pill-key k-' + t }, TYPE_LETTER[t]), TYPE_NAME[t])),
    h('li', null, h('i', { class: 'key today' }), 'Today'));
  const el = h('div', { class: 'cal cal-' + mode },
    h('div', { class: 'calhead' }, title, h('div', { class: 'calnav' }, now, prev, next)),
    grid, foot, key);

  function byDate() {
    const map = new Map();
    for (const s of data.shifts.values()) {
      if (s.deleted_at || s.id === exclude()) continue;
      (map.get(s.work_date) ?? map.set(s.work_date, []).get(s.work_date)).push(s);
    }
    return map;
  }

  function render() {
    const { y, m } = view;
    title.textContent = `${monthName(m)} ${y}`;
    const first = `${y}-${pad(m + 1)}-01`;
    const offset = weekdayIndex(first);
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const rows = Math.ceil((offset + days) / 7);
    const shifts = byDate();
    const sel = selected();

    // the month's own numbers, and its best day (for the shading)
    const month = { n: 0, minutes: 0, tips: 0, total: 0, best: 0 };
    const derived = new Map();
    for (let d = 1; d <= days; d++) {
      const date = `${y}-${pad(m + 1)}-${pad(d)}`;
      let dayTotal = 0;
      for (const s of shifts.get(date) ?? []) {
        const dv = derive(s);
        derived.set(s.id, dv);
        month.n += 1; month.minutes += dv.paid_minutes; month.tips += dv.tips_cents; month.total += dv.total_income_cents;
        dayTotal += dv.total_income_cents;
      }
      month.best = Math.max(month.best, dayTotal);
    }

    const cells = [...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => h('span', { class: 'dow', 'aria-hidden': 'true', title: weekdayName((i + 1) % 7) }, d))];
    const focusDate = sel && sel.slice(0, 7) === first.slice(0, 7) ? sel : today.slice(0, 7) === first.slice(0, 7) ? today : first;
    for (let i = 0; i < rows * 7; i++) {
      const date = addDays(first, i - offset);
      const inMonth = date.slice(0, 7) === first.slice(0, 7);
      const list = shifts.get(date) ?? [];
      const number = Number(date.slice(8));
      const cls = 'day' + (inMonth ? '' : ' out') + (date === today ? ' today' : '') + (date === sel ? ' sel' : '') + (list.length ? ' has' : '');
      const label = `${shortDate(date)}${list.length ? ': ' + list.map((s) => TYPE_NAME[s.shift_type]).join(' and ') + ' shift' + (list.length > 1 ? 's' : '') : ''}`;
      if (mode === 'pick') {
        const tips = list.reduce((a, s) => a + derived.get(s.id)?.tips_cents, 0) || 0;
        cells.push(h('button', { type: 'button', class: cls, 'data-date': date, 'aria-pressed': String(date === sel), 'aria-label': label, tabindex: date === focusDate ? '0' : '-1', title: list.length ? `${label}${tips ? ' · ' + usd0(tips) + ' tips' : ''}` : null },
          h('span', { class: 'dn' }, String(number)),
          list.length ? h('span', { class: 'marks' }, ...list.map((s) => h('i', { class: 'pill-key k-' + s.shift_type }, TYPE_LETTER[s.shift_type]))) : null,
          tips ? h('span', { class: 'amt' }, usd0(tips)) : null));
      } else {
        const dayTotal = list.reduce((a, s) => a + (derived.get(s.id)?.total_income_cents ?? 0), 0);
        const cell = h('div', { class: cls, 'data-date': date, title: list.length ? null : `Log a shift on ${shortDate(date)}` },
          h('span', { class: 'dn' }, String(number)),
          ...list.map((s) => {
            const dv = derived.get(s.id);
            return h('button', { type: 'button', class: 'chip k-' + s.shift_type, 'data-id': s.id, title: `${TYPE_NAME[s.shift_type]} · ${dv.paid_minutes ? hours1(dv.paid_minutes) : 'no hours'} worked · tips ${usd0(dv.tips_cents)} · total ${usd0(dv.total_income_cents)}`, 'aria-label': `Open ${label}` },
              h('b', null, TYPE_LETTER[s.shift_type]), h('span', null, hours1(dv.paid_minutes)), h('span', { class: 'ca' }, usd0(dv.total_income_cents)));
          }));
        if (inMonth && month.best > 0 && dayTotal > 0) css(cell, { '--heat': String(dayTotal / month.best) });
        cells.push(cell);
      }
    }
    const had = grid.contains(document.activeElement) ? document.activeElement.dataset?.date : null; // keep keyboard focus on the same day through the redraw
    grid.replaceChildren(...cells);
    if (had) grid.querySelector(`button.day[data-date="${had}"]`)?.focus({ preventScroll: true });
    grid.setAttribute('role', mode === 'pick' ? 'group' : 'presentation');
    grid.setAttribute('aria-label', `${monthName(m)} ${y}`);
    foot.replaceChildren(month.n
      ? tiles([
        { label: 'Shifts', value: String(month.n) },
        { label: 'Hours worked', value: hours1(month.minutes) },
        { label: 'Tips', value: usd0(month.tips), sub: month.minutes ? `${usd0(tipsPerHour(month))}/hr` : null },
        { label: 'Total income', value: usd0(month.total), sub: month.minutes ? `${usd0(totalPerHour(month))}/hr` : null },
      ], { label: `${monthName(m)} totals` })
      : h('p', { class: 'muted' }, `Nothing logged in ${monthName(m)} yet.`));
    css(el, { '--rows': String(rows) });
  }

  function go(delta) {
    const t = new Date(Date.UTC(view.y, view.m + delta, 1));
    view = { y: t.getUTCFullYear(), m: t.getUTCMonth() };
    render();
  }
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  now.addEventListener('click', () => { view = { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }; render(); });

  grid.addEventListener('click', (ev) => {
    if (mode === 'pick') {
      const day = ev.target.closest('button.day');
      if (day) onPick?.(day.dataset.date);
      return;
    }
    const chip = ev.target.closest('button.chip');
    if (chip) return void onOpen?.(chip.dataset.id);
    const cell = ev.target.closest('.day');
    if (cell) onNew?.(cell.dataset.date);
  });
  grid.addEventListener('keydown', (ev) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
    const from = ev.target.closest?.('button.day')?.dataset.date;
    if (!delta || !from) return;
    ev.preventDefault();
    const to = addDays(from, delta);
    if (to.slice(0, 7) !== from.slice(0, 7)) { view = { y: Number(to.slice(0, 4)), m: Number(to.slice(5, 7)) - 1 }; render(); }
    for (const b of grid.querySelectorAll('button.day')) b.tabIndex = b.dataset.date === to ? 0 : -1;
    grid.querySelector(`button.day[data-date="${to}"]`)?.focus();
  });

  render();
  return {
    el,
    render,
    // Put keyboard focus on the chosen day (or today, or the first of the month).
    focus() { (grid.querySelector('button.day[tabindex="0"]') ?? grid.querySelector('button.day'))?.focus({ preventScroll: true }); },
    // Turn to the month a date is in (the form does this when the date changes).
    show(date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return;
      const next = { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) - 1 };
      if (next.y !== view.y || next.m !== view.m) view = next;
      render();
    },
  };
}
