// Small pieces the dashboard draws its numbers with: stat tiles, column / dot-line / bar charts, the shift ribbon and the
// income mix bar. Everything is built from DOM calls (never markup strings), so a name from the database can only ever be
// text. Sizes are set through the CSSOM (element.style), which the page's content-security-policy allows; the look lives
// in styles.css. Every chart is HTML laid out in percentages, so it reflows with its container and needs no resize code.
//
// Rules the charts keep: one measure per axis (two measures are two charts), a legend when colour carries identity, the
// value at the end of a bar, a tooltip on hover *and* focus, and a table view so nothing depends on seeing colour.
import { wallMinutes } from '/time.js';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  decorate(el, props);
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, props, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  decorate(el, props);
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
function decorate(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'style') css(el, v); else el.setAttribute(k, v === true ? '' : v);
  }
}
// Custom properties and plain properties both go through the CSSOM.
export function css(el, obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v;
  }
  return el;
}

// ---- formatting ------------------------------------------------------------------------------
export const usd = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
export const usd0 = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const hours1 = (minutes) => `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`;
export const TYPE_NAME = { day: 'Day', night: 'Night', double: 'Double' };
export const TYPE_LETTER = { day: 'D', night: 'N', double: 'D+N' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => MONTHS[m];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (i) => WEEKDAYS[i];
// 'YYYY-MM-DD' -> "Sat, Sep 19", from the date's own parts (no timezone involved)
export function shortDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()].slice(0, 3)}, ${MONTHS[m - 1].slice(0, 3)} ${d}`;
}
export const clockText = (hh, mm = 0) => `${hh % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${hh < 12 ? 'AM' : 'PM'}`;

// A round top for an axis: 0..top in clean steps (1, 2, 5 × 10ⁿ).
export function niceScale(max, target = 4) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(v);
  return { top, ticks };
}

// ---- stat tiles: a label, the figure, and what it is measured against ---------------------------
// items: [{ label, value, sub?, hint?, lead? }]; `lead` makes one tile the larger, first read.
export function tiles(items, { label } = {}) {
  return h('dl', { class: 'tiles', 'aria-label': label },
    ...items.map((t) => h('div', { class: 'tile' + (t.lead ? ' lead' : ''), title: t.hint },
      h('dt', null, t.label),
      h('dd', null, t.value),
      t.sub ? h('div', { class: 'sub' }, t.sub) : null)));
}

// ---- facts: a quiet line of small figures, for pages where the input is the point ---------------------------------
// items: [{ label, value, note?, tone?: 'up' | 'down', hint? }]. A tone adds an arrow to its note, so direction never
// depends on colour alone.
export function facts(items) {
  return h('ul', { class: 'facts' }, ...items.filter(Boolean).map((f) => h('li', { class: 'fact' + (f.tone ? ' ' + f.tone : ''), title: f.hint },
    h('span', { class: 'fk' }, f.label), ' ', h('b', null, f.value),
    f.note ? h('span', { class: 'fn' }, ' ' + (f.tone === 'up' ? '▲ ' : f.tone === 'down' ? '▼ ' : '') + f.note) : null)));
}

// ---- tooltip: one per chart, values first, then what they are -------------------------------------
function makeTip(host) {
  const tip = h('div', { class: 'viztip', role: 'tooltip', hidden: true });
  host.append(tip);
  return {
    show(anchor, title, rows) {
      tip.replaceChildren(
        h('div', { class: 'tt-title' }, title),
        ...rows.map(([name, value, cls]) => h('div', { class: 'tt-row' }, h('i', { class: 'tt-key ' + (cls || '') }), h('b', null, value), h('span', null, name))));
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const at = anchor.getBoundingClientRect();
      const w = tip.offsetWidth;
      css(tip, {
        left: Math.max(4, Math.min(box.width - w - 4, at.left + at.width / 2 - box.left - w / 2)) + 'px',
        top: Math.max(0, at.top - box.top - tip.offsetHeight - 8) + 'px',
      });
    },
    hide() { tip.hidden = true; },
  };
}
function hoverable(node, tip, title, rows) {
  const on = () => tip.show(node, title, rows);
  node.addEventListener('pointerenter', on);
  node.addEventListener('focus', on);
  node.addEventListener('pointerleave', () => tip.hide());
  node.addEventListener('blur', () => tip.hide());
}

// A collapsed table of exactly what the chart shows, for anyone who can't or won't read the picture.
export function tableView(headers, rows) {
  return h('details', { class: 'viz-table' },
    h('summary', null, 'View as table'),
    h('table', null,
      h('thead', null, h('tr', null, ...headers.map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((c, i) => h('td', { class: i ? 'num' : '' }, c)))))));
}

// append the children that exist (a missing legend or caption is null, and append(null) would print "null")
function fill(el, ...kids) { for (const kid of kids) if (kid) el.append(kid); return el; }
function head(title, sub) {
  return title ? h('figcaption', { class: 'viz-cap' }, h('h4', null, title), sub ? h('span', { class: 'muted' }, sub) : null) : null;
}
function emptyFigure(title, text) {
  return h('figure', { class: 'viz' }, head(title), h('div', { class: 'viz-empty muted' }, text));
}
export function legend(items) {
  return h('ul', { class: 'legend' }, ...items.map((i) => h('li', null, h('i', { class: 'key ' + i.cls }), i.label)));
}

// ---- columns: one bar per period; a bar may be stacked from parts -------------------------------
// data: [{ xlabel, title, parts: [{ value, cls, name }], on? }]   `on` marks the bar the reader is looking at.
export function columnChart({ title, sub, data, fmt, height = 168, empty = 'Nothing logged in this range yet.', parts: partNames }) {
  const totals = data.map((d) => d.parts.reduce((a, p) => a + p.value, 0));
  const max = Math.max(0, ...totals);
  if (!data.length || max === 0) return emptyFigure(title, empty);
  const scale = niceScale(max);
  const fig = h('figure', { class: 'viz', role: 'group', 'aria-label': title });
  const tip = makeTip(fig);

  const grid = scale.ticks.map((t) => h('div', { class: 'grid', style: { bottom: (t / scale.top) * 100 + '%' } }));
  const yaxis = scale.ticks.map((t) => h('span', { class: 'yt', style: { bottom: (t / scale.top) * 100 + '%' } }, fmt(t)));
  const peak = totals.indexOf(max);
  const cols = data.map((d, i) => {
    const total = totals[i];
    const rows = d.parts.filter((p) => p.value > 0).map((p) => [p.name, fmt(p.value), p.cls]);
    if (d.parts.length > 1) rows.push(['Total', fmt(total)]);
    const bar = h('div', { class: 'bar', style: { height: (total / scale.top) * 100 + '%' } },
      ...d.parts.filter((p) => p.value > 0).map((p) => h('i', { class: 'part ' + p.cls, style: { flexGrow: String(p.value) } })),
      (i === peak || i === data.length - 1) && total > 0 ? h('span', { class: 'vl' }, fmt(total)) : null);
    const col = h('button', { type: 'button', class: 'col' + (d.on ? ' on' : ''), 'aria-label': `${d.title}: ${rows.map((r) => `${r[0]} ${r[1]}`).join(', ')}` }, bar);
    hoverable(col, tip, d.title, rows);
    return col;
  });
  fill(fig, head(title, sub),
    h('div', { class: 'plot', style: { '--plot-h': height + 'px' } },
      h('div', { class: 'yaxis', 'aria-hidden': 'true' }, ...yaxis),
      h('div', { class: 'area' }, ...grid, h('div', { class: 'cols' }, ...cols)),
      h('div', { class: 'xaxis', 'aria-hidden': 'true' }, ...data.map((d) => h('span', { class: 'xl' }, d.xlabel || '')))),
    partNames ? legend(partNames) : null,
    tableView(['Period', ...(data[0].parts.length > 1 ? data[0].parts.map((p) => p.name) : ['Value']), ...(data[0].parts.length > 1 ? ['Total'] : [])],
      data.map((d, i) => [d.title, ...d.parts.map((p) => fmt(p.value)), ...(d.parts.length > 1 ? [fmt(totals[i])] : [])])));
  return fig;
}

// ---- dots on a line: one dot per shift, coloured by its type ----------------------------------------
// data: [{ xlabel, title, y, cls, rows }]. `avg` draws a reference line with its label.
export function dotLine({ title, sub, data, fmt, valueLabel = 'Value', avg = null, height = 168, empty = 'Log a few shifts to see them here.', key }) {
  if (data.length < 2) return emptyFigure(title, empty);
  const max = Math.max(...data.map((d) => d.y), avg ?? 0);
  const scale = niceScale(max);
  const pos = (i) => (data.length === 1 ? 50 : 3 + (i / (data.length - 1)) * 94);
  const yPct = (v) => (v / scale.top) * 100;
  const fig = h('figure', { class: 'viz', role: 'group', 'aria-label': title });
  const tip = makeTip(fig);
  const line = svg('svg', { class: 'line', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('polyline', { points: data.map((d, i) => `${pos(i).toFixed(2)},${(100 - yPct(d.y)).toFixed(2)}`).join(' '), 'vector-effect': 'non-scaling-stroke' }));
  const dots = data.map((d, i) => {
    const dot = h('button', { type: 'button', class: 'pt ' + d.cls, 'aria-label': `${d.title}: ${fmt(d.y)}`, style: { left: pos(i) + '%', bottom: yPct(d.y) + '%' } });
    hoverable(dot, tip, d.title, d.rows);
    return dot;
  });
  // date labels: about five, always the first and last
  const every = Math.max(1, Math.ceil(data.length / 5));
  const last = data.length - 1;
  const xl = data.map((d, i) => (i % every === 0 || (i === last && last % every >= Math.ceil(every / 2)) ? d.xlabel : ''));
  fill(fig, head(title, sub),
    h('div', { class: 'plot', style: { '--plot-h': height + 'px' } },
      h('div', { class: 'yaxis', 'aria-hidden': 'true' }, ...scale.ticks.map((t) => h('span', { class: 'yt', style: { bottom: yPct(t) + '%' } }, fmt(t)))),
      h('div', { class: 'area' },
        ...scale.ticks.map((t) => h('div', { class: 'grid', style: { bottom: yPct(t) + '%' } })),
        avg != null ? h('div', { class: 'avgline', style: { bottom: yPct(avg) + '%' } }, h('span', null, `avg ${fmt(avg)}`)) : null,
        line, ...dots),
      h('div', { class: 'xaxis xaxis-free', 'aria-hidden': 'true' }, ...data.map((d, i) => h('span', { class: 'xl', style: { left: pos(i) + '%' } }, xl[i])))),
    key ? legend(key) : null,
    tableView(['Shift', valueLabel], data.map((d) => [d.title, fmt(d.y)])));
  return fig;
}

// ---- horizontal bars: a handful of categories, biggest first, the value at the tip --------------------
// data: [{ label, value, note?, cls?, on?, title? }]
export function hbars({ title, sub, data, fmt, empty = 'Nothing to compare yet.' }) {
  const shown = data.filter((d) => d.value != null);
  if (!shown.length) return emptyFigure(title, empty);
  const max = Math.max(...shown.map((d) => d.value)) || 1;
  return h('figure', { class: 'viz', role: 'group', 'aria-label': title },
    head(title, sub),
    h('ul', { class: 'hbars' }, ...data.map((d) => h('li', { class: 'hrow' + (d.on ? ' on' : ''), title: d.title },
      h('span', { class: 'hl' }, d.label, d.note ? h('span', { class: 'muted' }, ' ' + d.note) : null),
      h('span', { class: 'track' }, d.value == null ? null : h('i', { class: 'fill ' + (d.cls || ''), style: { width: Math.max(1.5, (d.value / max) * 100) + '%' } })),
      h('b', { class: 'hv' }, d.value == null ? '—' : fmt(d.value))))));
}

// ---- income mix: tips, wage and misc as one bar with a 2 px gap between them ---------------------------
export function incomeMix({ tips, wage, other }) {
  const parts = [['Tips', tips, 'inc-tips'], ['Wage', wage, 'inc-wage'], ['Misc', other, 'inc-other']];
  const total = parts.reduce((a, p) => a + (p[1] ?? 0), 0);
  if (total <= 0) return h('div', { class: 'viz-empty muted' }, 'No income entered yet.');
  return h('figure', { class: 'viz mix', role: 'group', 'aria-label': 'Where this shift’s income came from' },
    h('div', { class: 'mixbar' }, ...parts.filter((p) => p[1] > 0).map(([name, v, cls]) => h('i', { class: cls, title: `${name} ${usd(v)}`, style: { flexGrow: String(v) } }))),
    h('ul', { class: 'legend' }, ...parts.filter((p) => p[1] > 0).map(([name, v, cls]) =>
      h('li', null, h('i', { class: 'key ' + cls }), name + ' ', h('b', null, usd0(v)), h('span', { class: 'muted' }, total ? ` ${Math.round((v / total) * 100)}%` : '')))));
}

// ---- the shift ribbon ---------------------------------------------------------------------------------
// The shift laid out along the clock: your time as one bar with each break notched out of it, then (depending on the
// page it is on) a lane for parties and a lane per crew member. Positions come straight from the same resolved
// 'YYYY-MM-DDTHH:MM' times the form saves.
//   update({ S, E, breaks: [{start_at, end_at} | {minutes}], parties: [{name, start_at, end_at}], crew: [{name, start_at, end_at}] })
// `slim` is the quiet version for the form: a thin track and no legend (the bars say what they are when hovered).
export function createRibbon({ layers = [], slim = false } = {}) {
  const el = h('figure', { class: 'viz ribbon' + (slim ? ' slim' : '') });
  const clock = (t) => { const [hh, mm] = t.slice(11, 16).split(':').map(Number); return clockText(hh, mm); };
  function update({ S = null, E = null, breaks = [], parties = [], crew = [] } = {}) {
    if (!S || !E) return void el.replaceChildren(h('div', { class: 'viz-empty muted' }, 'Enter the start and end times to see the shift laid out.'));
    const timed = (x) => x.start_at && x.end_at;
    const spans = [{ start_at: S, end_at: E }, ...(layers.includes('parties') ? parties.filter(timed) : []), ...(layers.includes('crew') ? crew.filter(timed) : [])];
    const first = spans.reduce((a, x) => (x.start_at < a ? x.start_at : a), S);
    const last = spans.reduce((a, x) => (x.end_at > a ? x.end_at : a), E);
    const origin = first.slice(0, 13) + ':00';
    let total = wallMinutes(origin, last);
    total = Math.ceil(total / 60) * 60;
    if (total < 240) total = 240;
    const at = (t) => (Math.max(0, wallMinutes(origin, t)) / total) * 100;
    const width = (a, b) => ((wallMinutes(a, b)) / total) * 100;
    const stepH = total <= 480 ? 1 : total <= 840 ? 2 : 3;
    const ticks = [];
    for (let m = 0; m <= total; m += stepH * 60) ticks.push(m);
    const hourLabel = (m) => { const hh = (Number(origin.slice(11, 13)) + m / 60) % 24; return `${hh % 12 || 12}${hh < 12 ? 'a' : 'p'}`; };
    const lanes = [];
    const lane = (name, ...marks) => h('div', { class: 'lane' }, h('span', { class: 'lname' }, name), h('div', { class: 'ltrack' }, ...marks));

    const placed = breaks.filter(timed);
    lanes.push(lane('You',
      h('i', { class: 'seg-work', title: `You: ${clock(S)} to ${clock(E)}`, style: { left: at(S) + '%', width: width(S, E) + '%' } }),
      ...(layers.includes('breaks') ? placed.map((b, i) => h('i', { class: 'seg-break', title: `Break ${i + 1}: ${clock(b.start_at)} to ${clock(b.end_at)}`, style: { left: at(b.start_at) + '%', width: width(b.start_at, b.end_at) + '%' } })) : [])));
    if (layers.includes('parties')) {
      const timedParties = parties.filter(timed);
      if (timedParties.length) {
        lanes.push(lane('Party', ...timedParties.map((p, i) => h('i', { class: 'seg-party', title: `${p.name || `Party ${i + 1}`}: ${clock(p.start_at)} to ${clock(p.end_at)}`, style: { left: at(p.start_at) + '%', width: width(p.start_at, p.end_at) + '%' } }, h('span', null, p.name || `Party ${i + 1}`)))));
      }
    }
    if (layers.includes('crew')) {
      for (const c of crew.filter(timed)) lanes.push(lane(c.name, h('i', { class: 'seg-crew', title: `${c.name}: ${clock(c.start_at)} to ${clock(c.end_at)}`, style: { left: at(c.start_at) + '%', width: width(c.start_at, c.end_at) + '%' } })));
    }
    const notes = [];
    const loose = breaks.filter((b) => !timed(b));
    if (layers.includes('breaks') && loose.length) notes.push(`${loose.length === 1 ? 'A break' : loose.length + ' breaks'} given as a length only (${loose.reduce((a, b) => a + b.minutes, 0)} min) come off the hours but have no place on the clock.`);
    if (layers.includes('parties') && parties.some((p) => !timed(p))) notes.push('Parties without times are counted but not drawn.');
    if (layers.includes('crew') && crew.some((c) => !timed(c))) notes.push('People without times are on the shift but not drawn.');
    const key = [['seg-work', 'Worked']];
    if (layers.includes('breaks')) key.push(['seg-break', 'Break (unpaid)']);
    if (layers.includes('parties')) key.push(['seg-party', 'Party']);
    if (layers.includes('crew')) key.push(['seg-crew', 'Crew']);
    el.replaceChildren(...[
      h('div', { class: 'ribbon-body', role: 'img', 'aria-label': `Shift from ${clock(S)} to ${clock(E)}` + (placed.length ? `, ${placed.length} break${placed.length === 1 ? '' : 's'}` : '') },
        h('div', { class: 'lanes' },
          h('div', { class: 'vgrid', 'aria-hidden': 'true' }, ...ticks.map((m) => h('i', { style: { left: (m / total) * 100 + '%' } }))),
          ...lanes),
        h('div', { class: 'lane ticks' }, h('span', { class: 'lname' }), h('div', { class: 'ltrack' }, ...ticks.map((m) => h('span', { class: 'tick', style: { left: (m / total) * 100 + '%' } }, hourLabel(m)))))),
      slim ? null : h('ul', { class: 'legend' }, ...key.map(([cls, name]) => h('li', null, h('i', { class: 'key ' + cls }), name))),
      ...notes.map((n) => h('p', { class: 'muted' }, n)),
    ].filter(Boolean));
  }
  update();
  return { el, update };
}
