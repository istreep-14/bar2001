// The Overview page: what the shifts you have logged add up to, over a range you pick. Stat tiles first (total income
// leads), then hours and income by week, tips per hour shift by shift, and three small comparisons (by shift type, by
// weekday, by place). Every figure is worked out from the shifts on the page with the same derive() the table uses.
import { h, columnChart, dotLine, hbars, tiles, usd, usd0, hours1, TYPE_NAME, shortDate, monthName } from '/viz.js';
import { summarize, periods, tipsPerHour, totalPerHour } from '/insights.js';
import { addDays } from '/time.js';

const RANGES = [['30', '30 days'], ['90', '90 days'], ['year', 'This year'], ['all', 'All time']];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function createOverview({ data, derive, pane, onLoadMore }) {
  const body = pane.querySelector('[data-overview]');
  const rangeHost = pane.querySelector('[data-range]');
  let range = '30';
  const today = () => new Date().toLocaleDateString('en-CA');

  const radios = RANGES.map(([value, text]) => {
    const input = h('input', { type: 'radio', name: 'ovRange', value });
    input.checked = value === range;
    input.addEventListener('change', () => { range = value; render(); });
    return h('label', null, input, text);
  });
  rangeHost.replaceChildren(...radios);

  function bounds(live) {
    const to = today();
    if (range === 'all') return { from: live[0]?.work_date ?? to, to };
    if (range === 'year') return { from: to.slice(0, 4) + '-01-01', to };
    return { from: addDays(to, -(Number(range) - 1)), to };
  }

  function render() {
    if (pane.hidden) return;
    const live = [...data.shifts.values()].filter((s) => !s.deleted_at).sort((a, b) => (a.work_date < b.work_date ? -1 : 1));
    const { from, to } = bounds(live);
    const inRange = live.filter((s) => s.work_date >= from && s.work_date <= to);
    const sum = summarize(inRange, derive);
    const all = sum.all;
    if (!all.n) {
      body.replaceChildren(h('div', { class: 'empty' }, live.length ? 'No shifts in this range. Pick a longer one above.' : 'No shifts yet. Add your first with + New shift.'));
      return;
    }
    const tph = tipsPerHour(all);
    const types = ['day', 'night', 'double'].filter((t) => sum.byType[t].n);
    const typeMix = types.map((t) => `${sum.byType[t].n} ${TYPE_NAME[t].toLowerCase()}`).join(' · ');

    const { monthly, buckets } = periods(sum.rows, { from, to });
    const label = (b) => {
      if (monthly) return monthName(Number(b.key.slice(5)) - 1).slice(0, 3) + ' ’' + b.key.slice(2, 4);
      return shortDate(b.key).replace(/^\w+, /, '');
    };
    const every = Math.max(1, Math.ceil(buckets.length / 8));
    const bucketTitle = (b) => (monthly ? `${monthName(Number(b.key.slice(5)) - 1)} ${b.key.slice(0, 4)}` : `Week of ${shortDate(b.key)}`);

    const hoursChart = columnChart({
      title: 'Hours worked', sub: monthly ? 'per month' : 'per week (Mon–Sun)', fmt: (m) => hours1(m * 60),
      data: buckets.map((b, i) => ({ xlabel: i % every === 0 ? label(b) : '', title: bucketTitle(b), parts: [{ value: b.minutes / 60, cls: 'hrs', name: `${b.n} shift${b.n === 1 ? '' : 's'}` }] })),
    });
    // the bars hold hours, so the tooltip's value reads in hours; the shift count rides along as the row name
    const incomeChart = columnChart({
      title: 'Income', sub: monthly ? 'per month' : 'per week (Mon–Sun)', fmt: (c) => usd0(c * 100),
      parts: [{ cls: 'inc-tips', label: 'Tips' }, { cls: 'inc-wage', label: 'Wage (estimated)' }, { cls: 'inc-other', label: 'Misc' }],
      data: buckets.map((b, i) => ({ xlabel: i % every === 0 ? label(b) : '', title: bucketTitle(b), parts: [
        { value: b.tips / 100, cls: 'inc-tips', name: 'Tips' }, { value: b.wage / 100, cls: 'inc-wage', name: 'Wage' }, { value: b.other / 100, cls: 'inc-other', name: 'Misc' }] })),
    });

    const shiftDots = dotLine({
      title: 'Tips per hour, shift by shift', sub: 'each dot is a shift, oldest to newest; the line is your average', valueLabel: 'Tips per hour',
      fmt: (dollars) => usd0(dollars * 100), avg: tph == null ? null : tph / 100,
      data: sum.rows.filter((r) => r.d.tips_per_hour_cents != null).map(({ s, d }) => ({
        xlabel: shortDate(s.work_date).replace(/^\w+, /, ''), title: `${shortDate(s.work_date)} · ${TYPE_NAME[s.shift_type]}`, y: d.tips_per_hour_cents / 100, cls: 'k-' + s.shift_type,
        rows: [[`per hour over ${hours1(d.paid_minutes)}`, usd(d.tips_per_hour_cents), 'k-' + s.shift_type], ['Tips', usd(d.tips_cents)], ['Total income', usd(d.total_income_cents)]],
      })),
      key: types.map((t) => ({ cls: 'k-' + t, label: TYPE_NAME[t] })),
    });

    const perHourFmt = (c) => usd0(c);
    const typeBars = hbars({
      title: 'Tips per hour by shift type', sub: 'number = shifts', fmt: perHourFmt,
      data: ['day', 'night', 'double'].map((t) => ({ label: TYPE_NAME[t], note: sum.byType[t].n ? String(sum.byType[t].n) : '', value: sum.byType[t].n ? tipsPerHour(sum.byType[t]) : null, cls: 'k-' + t, title: `${TYPE_NAME[t]}: ${usd(sum.byType[t].tips)} tips over ${hours1(sum.byType[t].minutes)}` })),
    });
    const dayBars = hbars({
      title: 'Tips per hour by weekday', sub: 'number = shifts', fmt: perHourFmt,
      data: sum.byWeekday.map((b, i) => ({ label: WEEKDAYS[i], note: b.n ? `${b.n}` : '', value: b.n ? tipsPerHour(b) : null, cls: 'k-acc', title: b.n ? `${WEEKDAYS[i]}: ${usd(b.tips)} tips over ${hours1(b.minutes)}, ${b.n} shift${b.n === 1 ? '' : 's'}` : null })),
    });
    const places = [...sum.byLocation].map(([id, b]) => ({ id, name: data.locations.get(id)?.name ?? 'Removed place', b }))
      .sort((a, b) => b.b.n - a.b.n).slice(0, 6);
    const placeBars = hbars({
      title: 'Tips per hour by place', sub: 'number = shifts', fmt: perHourFmt, empty: 'Give your shifts a location to compare places.',
      data: places.map(({ name, b }) => ({ label: name, note: `${b.n}`, value: tipsPerHour(b), cls: 'k-acc', title: `${name}: ${usd(b.tips)} tips over ${hours1(b.minutes)}, ${b.n} shift${b.n === 1 ? '' : 's'}` })),
    });

    body.replaceChildren(...[
      tiles([
        { label: 'Total income', value: usd0(all.total), sub: totalPerHour(all) == null ? null : `${usd0(totalPerHour(all))} per hour`, lead: true, hint: 'Tips + estimated wage + misc' },
        { label: 'Tips', value: usd0(all.tips), sub: tph == null ? null : `${usd0(tph)} per hour` },
        { label: 'Hours worked', value: hours1(all.minutes), sub: `${all.n} shift${all.n === 1 ? '' : 's'}${typeMix ? ' · ' + typeMix : ''}` },
        { label: 'Per shift', value: usd0(Math.round(all.total / all.n)), sub: `${hours1(Math.round(all.minutes / all.n))} average` },
      ], { label: 'Totals for this range' }),
      h('div', { class: 'chartgrid two' }, h('div', { class: 'card' }, hoursChart), h('div', { class: 'card' }, incomeChart)),
      h('div', { class: 'card' }, shiftDots),
      h('div', { class: 'chartgrid three' }, h('div', { class: 'card' }, typeBars), h('div', { class: 'card' }, dayBars), h('div', { class: 'card' }, placeBars)),
      all.wageMissing ? h('p', { class: 'muted' }, `${all.wageMissing} shift${all.wageMissing === 1 ? ' has' : 's have'} no hourly rate in effect, so wage and total income leave ${all.wageMissing === 1 ? 'it' : 'them'} out. Set your rate under Lists.`) : null,
      h('p', { class: 'muted' }, `Worked out from the ${live.length} shift${live.length === 1 ? '' : 's'} loaded${data.cursor ? ' (older ones are not loaded yet)' : ''}. Hours are worked time: length minus breaks. `,
        data.cursor ? (() => { const more = h('button', { type: 'button', class: 'linkbtn' }, 'Load older shifts'); more.addEventListener('click', () => onLoadMore?.()); return more; })() : null),
    ].filter(Boolean));
  }

  return { render };
}
