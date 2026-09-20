// The add/edit shift form. Talks to the API only through the `request` it is given, and saves
// with the idempotent PUT /shifts/:id. Times are wall-clock (no timezones): the form works out
// which date each typed clock time falls on with the same helpers the server validates with
// (served at /time.js), so the two can never disagree about overnight shifts.
//
// The form is not a popup and not one long scroll. It is a set of pages in section groups (Info: Date, Time, Type;
// Income: Tips, Wage, Misc; Details: Location, Crew, Party, Notes), each a tab in the left panel (dashboard/stepper.js)
// with a live one-line summary, and the selected page's input in the panel to the right. Each page also shows what
// the shift comes to as you fill it in (stat tiles, and a chart where one helps): the Date page is a calendar of the
// shifts you have logged, Time draws the shift along the clock with its breaks, Tips and Location compare with your
// history. Things that can be many (breaks, parties, the people on the shift) are a strip of tabs, one editor open at a time. The lists a shift points at are
// not pages of their own here: each is edited on the page it feeds (dashboard/lists.js), so locations are on Location,
// misc types on Misc and wage rates, as date ranges, on Wage. Location is picked from a list that lives on the server
// and employees from the employees table; a name typed that isn't there yet is added on save. Within Crew, the person
// picked has their own block (start, end, tips, role). Tips are the main income (entered), Wage is worked out
// (read-only) and Misc is any other income type you have added (entered).
import { toMinutes, addDays, joinLocal, wallMinutes, resolveEnd, resolveNearSpan, dateOf, timeOf, daysBetween } from '/time.js';
import { deriveShift, hoursText, isBartender } from '/pay.js';
import { SUGGESTED_ROLES } from '/employees.js';
import { createTabs } from '/tabs.js';
import { createCalendar } from '/calendar.js';
import { summarize, tipsPerHour, perHour } from '/insights.js';
import { facts, createRibbon, usd0, TYPE_NAME } from '/viz.js';

const FIELD_LABELS = {
  job_id: 'Job', location_id: 'Location', employees: 'Employees', parties: 'Party', work_date: 'Date', start_at: 'Start', end_at: 'End',
  shift_type: 'Shift type', breaks: 'Breaks', notes: 'Notes', tags: 'Tags', money_entries: 'Income',
};
const otherPart = (part) => (part === 'day' ? 'night' : 'day');
const PILL_LIMIT = 24; // how many list entries are offered as tap targets; the rest are still reachable by typing

// crypto.randomUUID only exists in secure contexts (https or localhost); over plain http on a
// LAN or Tailscale address it is missing, so fall back to getRandomValues.
export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// "12", "12.5", "$1,234.56" -> cents. Null if it isn't a plain dollar amount. No floats involved.
export function parseDollars(text) {
  const m = /^\$?(\d{1,7})?(?:\.(\d{1,2}))?$/.exec(String(text).replace(/[,\s]/g, ''));
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Number(m[1] ?? 0) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const blank = (v) => (v == null ? '' : String(v));
const orNull = (v) => (v.trim() === '' ? null : v.trim());
const friendly = (msg) => msg.replace(/^(\w+):/, (_, key) => `${FIELD_LABELS[key] ?? key}:`);
const usd = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

let breakCounter = 0;

// Zero to many breaks for any time range, as a strip of tabs: "Break 1 · 30 min", "Break 2 · 15 min", "+ Add break". One
// break's editor is open at a time. A break is a start and end time, or (switch) just a length in minutes. Give `read` the
// range's resolved start and end ('YYYY-MM-DDTHH:MM') and it returns { value: [{start_at, end_at} | {minutes}], problems }.
export function createBreakList({ h, onChange }) {
  const uid = ++breakCounter;
  let serial = 0;
  let rows = [];
  const tabs = createTabs({
    label: 'Breaks', addLabel: '+ Add break', empty: 'No breaks. Add one if you took any: a start and end time, or just how long.',
    onAdd() { const row = makeRow(); rows.push(row); sync(row.id); onChange?.(); row.start.focus(); },
  });
  const el = tabs.el;

  // "30 min" for the tab: a typed length, or the gap between the two times
  function lengthText(row) {
    if (row.mode === 'minutes') return /^\d{1,4}$/.test(row.minutes.value.trim()) ? `${Number(row.minutes.value)} min` : 'no length';
    const s = toMinutes(row.start.value);
    const e = toMinutes(row.end.value);
    return s === null || e === null ? 'no times' : `${(e - s + 1440) % 1440 || 1440} min`;
  }

  function makeRow(init = {}) {
    const n = ++serial;
    const row = { id: n, mode: init.minutes ? 'minutes' : 'range' };
    row.start = h('input', { type: 'time', id: `brk${uid}-${n}s` });
    row.end = h('input', { type: 'time', id: `brk${uid}-${n}e` });
    row.minutes = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', id: `brk${uid}-${n}m`, placeholder: '30' });
    if (init.start_at) { row.start.value = timeOf(init.start_at); row.end.value = timeOf(init.end_at); }
    if (init.minutes) row.minutes.value = String(init.minutes);
    row.swap = h('button', { type: 'button', class: 'linkbtn' });
    row.remove = h('button', { type: 'button', class: 'linkbtn' }, 'Remove this break');
    row.rangeFields = h('div', { class: 'bfields' }, h('label', { class: 'mini' }, 'Starts', row.start), h('span', { class: 'to', 'aria-hidden': 'true' }, '→'), h('label', { class: 'mini' }, 'Ends', row.end));
    row.minuteFields = h('div', { class: 'bfields' }, h('label', { class: 'mini' }, 'Length in minutes', row.minutes));
    row.el = h('div', { class: 'brow' }, row.rangeFields, row.minuteFields, h('div', { class: 'bacts' }, row.swap, row.remove));
    for (const input of [row.start, row.end, row.minutes]) {
      input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); tabs.setSub(row.id, lengthText(row)); });
    }
    row.swap.addEventListener('click', () => { row.mode = row.mode === 'range' ? 'minutes' : 'range'; sync(row.id); (row.mode === 'range' ? row.start : row.minutes).focus(); });
    row.remove.addEventListener('click', () => {
      const i = rows.indexOf(row);
      rows.splice(i, 1);
      sync(rows[Math.min(i, rows.length - 1)]?.id);
      onChange?.();
      if (rows.length) tabs.select(rows[Math.min(i, rows.length - 1)].id, { focus: true }); else tabs.focusAdd();
    });
    return row;
  }

  function sync(select) {
    rows.forEach((row, i) => {
      const name = `Break ${i + 1}`;
      row.el.setAttribute('aria-label', name);
      row.remove.setAttribute('aria-label', `Remove ${name.toLowerCase()}`);
      row.start.setAttribute('aria-label', `${name} start`);
      row.end.setAttribute('aria-label', `${name} end`);
      row.minutes.setAttribute('aria-label', `${name} length in minutes`);
      row.rangeFields.hidden = row.mode !== 'range';
      row.minuteFields.hidden = row.mode !== 'minutes';
      row.swap.textContent = row.mode === 'range' ? 'Enter a length instead' : 'Enter times instead';
    });
    tabs.setItems(rows.map((row, i) => ({ id: row.id, label: `Break ${i + 1}`, sub: lengthText(row), panel: row.el })), { select });
  }

  function load(breaks = []) {
    rows = breaks.map(makeRow);
    sync(rows[0]?.id);
  }

  function read({ S, E }) {
    const problems = [];
    const bad = (el, msg) => problems.push({ el, msg });
    const value = [];
    const ranges = [];
    let total = 0;
    rows.forEach((row, i) => {
      const name = `Break ${i + 1}`;
      if (row.mode === 'range') {
        if (!row.start.value && !row.end.value) return; // an empty row is just skipped
        if (!row.start.value || !row.end.value) return bad(row.start.value ? row.end : row.start, `${name}: enter both a start and an end, or remove it.`);
        const start_at = resolveNearSpan(S, E, row.start.value);
        const end_at = resolveEnd(start_at, row.end.value);
        if (start_at < S || end_at > E) return bad(row.start, `${name}: it has to fall inside the shift.`);
        ranges.push({ start_at, end_at, row, name });
        value.push({ start_at, end_at });
        total += wallMinutes(start_at, end_at);
        return;
      }
      const text = row.minutes.value.trim();
      if (text === '') return;
      if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > 1440) return bad(row.minutes, `${name}: the length is whole minutes, 1 to 1440.`);
      value.push({ minutes: Number(text) });
      total += Number(text);
    });
    ranges.sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0));
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start_at < ranges[i - 1].end_at) bad(ranges[i].row.start, `${ranges[i].name} overlaps ${ranges[i - 1].name}.`);
    }
    if (!problems.length && total > wallMinutes(S, E)) bad(rows[0] && (rows[0].mode === 'range' ? rows[0].start : rows[0].minutes), 'Together the breaks are longer than the shift.');
    return { value, problems };
  }

  load([]);
  return { el, tabs, load, read, count: () => rows.length };
}

let partyCounter = 0;

// Zero to many parties, as a strip of tabs (each named for its party, "Smith 40th · 40 guests"). That a shift had one is
// what matters (a yes/no to compare shifts by), so every detail is optional: an empty tab is still a party.
// `read` gives { value: [{name, guests, start_at, end_at, notes}], problems }.
export function createPartyList({ h, onChange }) {
  const uid = ++partyCounter;
  let serial = 0;
  let rows = [];
  const tabs = createTabs({
    label: 'Parties', addLabel: '+ Add another party', empty: '',
    onAdd() { const row = makeRow(); rows.push(row); sync(row.id); onChange?.(); row.name.focus(); },
  });
  const el = tabs.el;

  const field = (label, input) => h('label', { class: 'mini' }, label, input);
  const nameOf = (row, i) => row.name.value.trim() || `Party ${i + 1}`;
  const guestsOf = (row) => (row.guests.value.trim() ? `${row.guests.value.trim()} guests` : '');

  function makeRow(init = {}) {
    const n = ++serial;
    const row = { id: n };
    row.name = h('input', { type: 'text', maxlength: '200', autocomplete: 'off', placeholder: 'Who it was for, or what', id: `pty${uid}-${n}n` });
    row.guests = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'How many', id: `pty${uid}-${n}g` });
    row.start = h('input', { type: 'time', id: `pty${uid}-${n}s` });
    row.end = h('input', { type: 'time', id: `pty${uid}-${n}e` });
    row.notes = h('input', { type: 'text', maxlength: '2000', autocomplete: 'off', placeholder: 'Anything worth remembering', id: `pty${uid}-${n}o` });
    row.name.value = blank(init.name);
    row.guests.value = blank(init.guests);
    row.notes.value = blank(init.notes);
    if (init.start_at) { row.start.value = timeOf(init.start_at); row.end.value = timeOf(init.end_at); }
    row.remove = h('button', { type: 'button', class: 'linkbtn' }, 'Remove this party');
    row.el = h('div', { class: 'prow' },
      h('div', { class: 'pgrid' }, field('Name', row.name), field('Guests', row.guests), field('Starts', row.start), field('Ends', row.end)),
      field('Notes', row.notes),
      h('div', { class: 'bacts' }, row.remove));
    for (const input of [row.name, row.guests, row.start, row.end, row.notes]) input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    for (const input of [row.name, row.guests]) {
      input.addEventListener('input', () => { tabs.setLabel(row.id, nameOf(row, rows.indexOf(row))); tabs.setSub(row.id, guestsOf(row)); });
    }
    row.remove.addEventListener('click', () => {
      const i = rows.indexOf(row);
      rows.splice(i, 1);
      sync(rows[Math.min(i, rows.length - 1)]?.id);
      onChange?.();
      if (rows.length) tabs.select(rows[Math.min(i, rows.length - 1)].id, { focus: true }); else tabs.focusAdd();
    });
    return row;
  }

  function sync(select) {
    rows.forEach((row, i) => {
      const name = `Party ${i + 1}`;
      row.el.setAttribute('aria-label', name);
      row.remove.setAttribute('aria-label', `Remove ${name.toLowerCase()}`);
    });
    tabs.setItems(rows.map((row, i) => ({ id: row.id, label: nameOf(row, i), sub: guestsOf(row), panel: row.el })), { select });
  }

  function read({ S, E }) {
    const problems = [];
    const bad = (el, msg) => problems.push({ el, msg });
    const value = [];
    rows.forEach((row, i) => {
      const name = `Party ${i + 1}`;
      const guestsText = row.guests.value.trim();
      let guests = null;
      if (guestsText !== '') {
        if (!/^\d{1,6}$/.test(guestsText) || Number(guestsText) < 1 || Number(guestsText) > 100000) return bad(row.guests, `${name}: guests is a whole number, 1 or more.`);
        guests = Number(guestsText);
      }
      let start_at = null;
      let end_at = null;
      if (row.start.value || row.end.value) {
        if (!row.start.value || !row.end.value) return bad(row.start.value ? row.end : row.start, `${name}: enter both a start and an end, or neither.`);
        start_at = resolveNearSpan(S, E, row.start.value);
        end_at = resolveEnd(start_at, row.end.value);
      }
      value.push({ name: orNull(row.name.value), guests, start_at, end_at, notes: orNull(row.notes.value) });
    });
    return { value, problems };
  }

  sync();
  return {
    el,
    tabs,
    count: () => rows.length,
    load(parties = []) { rows = parties.map(makeRow); sync(rows[0]?.id); },
    // the yes/no checkbox: on adds an empty party, off removes them all
    setPresent(on) { if (on && rows.length === 0) rows.push(makeRow()); if (!on) rows = []; sync(rows[0]?.id); },
    read,
    // One short line per party, for the form's summary: "Smith 40th · 40 guests".
    summary: () => rows.map((row, i) => [nameOf(row, i), guestsOf(row)].filter(Boolean).join(' · ')),
  };
}

// `stepper` is the dialog the form lives in (dashboard/stepper.js: it opens, closes and switches pages), `onDataChanged` says a
// person was changed through the form (their role) so the page redraws, `onShiftDate(date | null)` tells the lists which
// date the shift is on. The lists themselves (locations, misc types, wage rates) are not edited here: they live under Lists.
export function createShiftForm({ h, request, isAuthError, data, stepper, derive, onDataChanged, onShiftDate, onSaved, onAuth }) {
  const $ = (id) => document.getElementById(id);
  const root = $('shiftForm'); // every group's pane is inside it
  const INVALID = '#shiftForm [aria-invalid]';
  const breakList = createBreakList({ h, onChange: () => refreshDerived() });
  $('breakHost').append(breakList.el);
  const partyList = createPartyList({ h, onChange: () => { $('fParty').checked = partyList.count() > 0; refreshDerived(); } });
  $('partyHost').append(partyList.el);
  const typeRadios = [...root.querySelectorAll('input[name="shiftType"]')];
  // The people on the shift are a strip of tabs too: one person's start, end, tips and role open at a time.
  const crewTabs = createTabs({
    label: 'People on this shift', addLabel: '+ Add someone', empty: 'No one else is on this shift. Tap a name above, or type one, to add them.',
    onAdd: () => $('fEmployee').focus(),
    onSelect(id) { if (ctx) ctx.crew = ctx.staff.find((m) => m.uid === id) ?? ctx.crew; },
  });
  $('crewHost').append(crewTabs.el);
  // Drawn pictures: the Date page's calendar of your shifts, and the shift laid out along the clock on Time, Crew and Party.
  const pickCalendar = createCalendar({
    mode: 'pick', data, derive,
    selected: () => $('fDate').value,
    exclude: () => ctx?.id ?? null,
    onPick(date) {
      $('fDate').value = date;
      if (ctx) ctx.startDelta = 0;
      $('fDate').dispatchEvent(new Event('input', { bubbles: true })); // the form's own listeners take it from here
    },
  });
  $('dateCal').append(pickCalendar.el);
  const ribbons = { time: createRibbon({ layers: ['breaks'], slim: true }), crew: createRibbon({ layers: ['crew'], slim: true }), party: createRibbon({ layers: ['parties'], slim: true }) };
  $('timeRibbon').append(ribbons.time.el);
  $('crewRibbon').append(ribbons.crew.el);
  $('partyRibbon').append(ribbons.party.el);

  // One open form: { mode, id, orig, opener, startDelta, baseline, saving, armed,
  //                  type: '' | 'day' | 'night' | 'double', entries: [{id, category_id, value, part, el}],
  //                  staff: [{employee_id: string|null, name, start, end, tips, role, detail, uid}], crew: the staff member
  //                  shown in the Crew tab, loadedLocation: {id, name} | null }
  // An entry's `part` ('', 'day' or 'night') only matters on a double; '' is "combined / not sure".
  // A staff member with a null employee_id is a name typed in that isn't on the employees table yet.
  // Their `start`/`end` are clock times ('HH:MM') and `tips` is dollars as typed; all three may be empty. `role` is only
  // used for a name that isn't on the table yet (an existing person's role is theirs, and is saved as it is changed).
  // `detail` is that person's block of inputs in the Crew tab, built once and kept, so typed values survive a redraw.
  let ctx = null;
  // A new income row is Tips unless told otherwise (Tips is the built-in type; null only before the lists have loaded,
  // and the server treats a missing type as Tips too).
  const tipsId = () => [...data.incomeCategories.values()].find((c) => c.system)?.id ?? null;
  const newEntry = (part = '', category_id = tipsId()) => ({ id: null, category_id, value: '', part, el: null });
  const isTips = (e) => !e.category_id || e.category_id === tipsId();
  const otherTypes = () => [...data.incomeCategories.values()].filter((c) => !c.system && !c.archived).sort((a, b) => a.name.localeCompare(b.name));

  // ---- opening -----------------------------------------------------------------------
  function newestLive() {
    let best = null;
    for (const s of data.shifts.values()) if (!s.deleted_at && (!best || s.start_at > best.start_at)) best = s;
    return best;
  }

  const localDate = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toLocaleDateString('en-CA');
  };
  function defaultDate() {
    return localDate(new Date().getHours() < 6 ? -1 : 0); // logging the night you just finished
  }

  function openNew(openerSel, { date } = {}) {
    const last = newestLive();
    ctx = { mode: 'new', id: newId(), orig: null, opener: openerSel, baseline: null, startDelta: 0, type: '', entries: [newEntry()], staff: [], crew: null, loadedLocation: null };
    const lastPlace = last?.location_id && data.locations.get(last.location_id);
    show({
      title: 'New shift',
      date: date ?? defaultDate(),
      start: last ? timeOf(last.start_at) : '',
      end: last ? timeOf(last.end_at) : '',
      location: lastPlace && !lastPlace.archived ? lastPlace.name : '',
      hint: last ? 'Times and location are copied from your most recent shift.' : '',
      focus: 'date',
    });
  }

  function openEdit(shift, openerSel) {
    const place = shift.location_id ? data.locations.get(shift.location_id) : null;
    ctx = {
      mode: 'edit', id: shift.id, orig: shift, opener: openerSel, baseline: shift.updated_at,
      startDelta: daysBetween(shift.work_date, dateOf(shift.start_at)), // usually 0; keeps a work date that differs from the start date
      type: shift.shift_type,
      entries: shift.money_entries.map((m) => ({ id: m.id, category_id: m.category_id, value: (m.value_cents / 100).toFixed(2), part: m.part ?? '', el: null })),
      staff: shift.employees.map((e) => ({
        employee_id: e.employee_id, name: data.employees.get(e.employee_id)?.name ?? 'Removed employee',
        start: e.start_at ? timeOf(e.start_at) : '', end: e.end_at ? timeOf(e.end_at) : '', tips: e.tips_cents == null ? '' : (e.tips_cents / 100).toFixed(2), role: '',
      })),
      crew: null,
      loadedLocation: place ? { id: place.id, name: place.name } : null,
    };
    show({
      title: 'Edit shift', date: shift.work_date, start: timeOf(shift.start_at), end: timeOf(shift.end_at),
      location: place?.name ?? '', tags: shift.tags.join(', '), notes: blank(shift.notes), breaks: shift.breaks, parties: shift.parties,
      banner: shift.deleted_at ? 'This shift is deleted. Saving restores it.' : '', focus: 'date',
    });
  }

  function show(v) {
      for (const r of typeRadios) r.checked = r.value === ctx.type;
    $('typeSeg').removeAttribute('aria-invalid');
    $('fDate').value = v.date;
    $('fStart').value = v.start;
    $('fEnd').value = v.end;
    breakList.load(v.breaks ?? []);
    partyList.load(v.parties ?? []);
    $('fParty').checked = partyList.count() > 0;
    $('fLocation').value = v.location;
    $('fEmployee').value = '';
    $('fTags').value = blank(v.tags);
    $('fNotes').value = blank(v.notes);
    renderLists();
    renderEntries();
    syncNextDay();
    refreshDerived();
    showBanner(v.banner ?? '');
    $('formHint').textContent = v.hint ?? '';
    hideProblems();
    setBusy(false);
    disarm();
    $('deleteShift').hidden = ctx.mode !== 'edit' || !!ctx.orig.deleted_at;
    $('saveShift').textContent = ctx.orig?.deleted_at ? 'Save and restore' : 'Save shift';
    if (ctx) ctx.dirty = false;
    disarmClose();
    stepper.open({ title: v.title, show: 'date' });
    pickCalendar.focus();
  }

  // ---- date ---------------------------------------------------------------------------
  const LONG_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  function paintDate(date) {
    const note = $('dateNote');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { note.textContent = 'Pick a day on the calendar.'; note.classList.remove('warn'); return; }
    const [y, m, d] = date.split('-').map(Number);
    const same = [...data.shifts.values()].filter((s) => !s.deleted_at && s.id !== ctx.id && s.work_date === date);
    note.classList.toggle('warn', same.length > 0);
    note.textContent = LONG_DATE.format(new Date(Date.UTC(y, m - 1, d)))
      + (same.length ? ` · you already logged a ${same.map((s) => TYPE_NAME[s.shift_type].toLowerCase()).join(' and a ')} shift on this date.` : '');
  }

  // ---- shift type ---------------------------------------------------------------------
  // Choosing Double makes the tips per half: what was entered so far stays with the type it was
  // entered under, and a second entry is offered for the other half. Going back to Day or Night
  // puts every entry on that type.
  function setType(next) {
    const prev = ctx.type;
    ctx.type = next;
    $('typeSeg').removeAttribute('aria-invalid');
    if (next === 'double' && prev !== 'double') {
      const carried = prev === 'day' || prev === 'night' ? prev : '';
      for (const e of ctx.entries) e.part = e.part || carried;
      const tips = ctx.entries.filter(isTips);
      if (tips.length === 1) { // one tips entry so far: offer a row for the other half
        tips[0].part ||= 'day';
        ctx.entries.push(newEntry(otherPart(tips[0].part)));
      }
    }
    renderEntries();
  }
  for (const r of typeRadios) r.addEventListener('change', () => { if (r.checked) setType(r.value); });

  // ---- shift times --------------------------------------------------------------------
  function syncNextDay() {
    const s = toMinutes($('fStart').value);
    const e = toMinutes($('fEnd').value);
    $('nextDay').hidden = !(s !== null && e !== null && e <= s);
  }
  for (const id of ['fStart', 'fEnd']) $(id).addEventListener('input', () => { if (ctx) syncNextDay(); });

  // ---- tips and misc income rows --------------------------------------------------------
  // Two groups, one list: tips rows (no type to choose) and other-income rows (a type from your list).
  // Each row: [type,] (on a double) which half, the amount, a remove.
  const typeChoices = (current) => [...data.incomeCategories.values()]
    .filter((c) => !c.system && (!c.archived || c.id === current)) // a removed type still shows on the entries that use it
    .sort((a, b) => a.name.localeCompare(b.name));

  function renderEntries() {
    const double = ctx.type === 'double';
    const tips = ctx.entries.filter(isTips);
    const other = ctx.entries.filter((e) => !isTips(e));
    $('tipRows').replaceChildren(...tips.map((e, i) => entryEl(e, i, 'Tips')));
    $('otherRows').replaceChildren(...other.map((e, i) => entryEl(e, i, 'Misc')));
    $('combinedHint').hidden = !double;
    const haveTypes = otherTypes().length > 0;
    $('addOther').hidden = !haveTypes;
    $('otherHint').hidden = haveTypes || other.length > 0;
  }

  function entryEl(e, i, group) {
    const n = i + 1;
    const double = ctx.type === 'double';
    const tips = group === 'Tips';
    const value = h('input', { type: 'text', inputmode: 'decimal', placeholder: '$0.00', autocomplete: 'off', 'aria-label': `${group} entry ${n} amount in dollars` });
    value.value = e.value;
    value.addEventListener('input', () => { e.value = value.value; value.removeAttribute('aria-invalid'); });
    let kind = null;
    if (!tips) {
      kind = h('select', { 'aria-label': `${group} entry ${n}: type` }, typeChoices(e.category_id).map((c) => h('option', { value: c.id }, c.name)));
      kind.value = e.category_id ?? '';
      kind.addEventListener('change', () => { e.category_id = kind.value || null; });
    }
    let half = null;
    if (double) {
      half = h('select', { 'aria-label': `${group} entry ${n}: which part of the shift` },
        h('option', { value: '' }, 'Combined'),
        h('option', { value: 'day' }, 'Day'),
        h('option', { value: 'night' }, 'Night'));
      half.value = e.part;
      half.addEventListener('change', () => { e.part = half.value; });
    }
    const remove = h('button', { type: 'button', class: 'linkbtn x', 'aria-label': `Remove ${group.toLowerCase()} entry ${n}` }, '✕');
    remove.addEventListener('click', () => { ctx.entries.splice(ctx.entries.indexOf(e), 1); renderEntries(); });
    e.el = { value };
    return h('div', { class: `mrow ${tips ? 't' : 'o'}${double ? 2 : 1}` }, kind, half, value, remove);
  }

  $('addTips').addEventListener('click', () => {
    // on a double, offer the first half that has no tips yet
    const tips = ctx.entries.filter(isTips);
    const free = ctx.type === 'double' ? ['day', 'night'].find((p) => !tips.some((e) => e.part === p)) : '';
    const entry = newEntry(free ?? '');
    ctx.entries.push(entry);
    renderEntries();
    entry.el.value.focus();
  });

  $('addOther').addEventListener('click', () => {
    const entry = newEntry('', otherTypes()[0]?.id ?? null);
    ctx.entries.push(entry);
    renderEntries();
    entry.el.value.focus();
  });

  // ---- the derived preview: the estimated wage, and the shift's staff totals -----------------
  // Read-only. It uses the same pay.js as the server, so what is shown here is what the API will say.
  const staffDoc = (m, S, E) => {
    const times = m.start && m.end && toMinutes(m.start) !== null && toMinutes(m.end) !== null
      ? (() => { const start_at = resolveNearSpan(S, E, m.start); return { start_at, end_at: resolveEnd(start_at, m.end) }; })()
      : { start_at: null, end_at: null };
    const cents = m.tips.trim() === '' ? null : parseDollars(m.tips);
    return { employee_id: m.employee_id ?? `new:${m.name}`, ...times, tips_cents: cents };
  };
  // A person who isn't on the table yet has no id, only the role typed for them in the Crew tab.
  const roleOf = (id) => {
    const member = ctx.staff.find((m) => (m.employee_id ?? `new:${m.name}`) === id);
    return member && !member.employee_id ? member.role || null : data.employees.get(id)?.role ?? null;
  };

  // Everything on the form that is worked out from what has been entered. The drawn parts (tiles, ribbons, charts) are only
  // rebuilt for the page on show; the tab summaries and the wage line are always current.
  let history = null;
  const liveShifts = () => [...data.shifts.values()].filter((s) => !s.deleted_at);
  // Your other shifts, summed once per refresh and only if a page needs them.
  const past = () => (history ??= summarize(liveShifts(), derive, { exclude: ctx.id }));

  function refreshDerived() {
    if (!ctx) return;
    history = null;
    const box = $('wageLine');
    const date = $('fDate').value;
    const shown = stepper.current();
    onShiftDate?.(/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null); // the wage range that applies is marked on the Wage page
    if (shown === 'date') { paintDate(date); pickCalendar.show(date); }
    if (shown === 'type') paintTypeHistory();
    const startMin = toMinutes($('fStart').value);
    const endMin = toMinutes($('fEnd').value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || startMin === null || endMin === null) {
      paintSummaries(null);
      paintVisuals(shown, null);
      return box.replaceChildren(h('span', { class: 'muted' }, 'Enter the date and times to see an estimate.'));
    }
    const S = joinLocal(addDays(date, ctx.startDelta), startMin);
    const E = resolveEnd(S, $('fEnd').value);
    const r = breakList.read({ S, E });
    const pr = partyList.read({ S, E });
    const money_entries = ctx.entries
      .map((e) => ({ category_id: e.category_id, value_cents: parseDollars(e.value) }))
      .filter((m) => m.value_cents !== null);
    const d = deriveShift({
      work_date: date, start_at: S, end_at: E, breaks: r.problems.length ? [] : r.value, money_entries,
      employees: ctx.staff.map((m) => staffDoc(m, S, E)), parties: pr.value,
    }, [...data.wageRates.values()], roleOf);

    if (d.estimated_wage_cents === null) {
      box.replaceChildren(h('span', { class: 'muted' }, 'No hourly wage in effect on this date. Set your rate under Lists after saving.'));
    } else {
      box.replaceChildren(
        h('span', { class: 'wageamt' }, usd(d.estimated_wage_cents)),
        h('span', { class: 'muted' }, `${hoursText(d.paid_minutes)} paid × ${usd(d.wage_rate_cents)}/hr, breaks unpaid`));
    }
    paintSummaries(d);
    paintVisuals(shown, { d, S, E, breaks: r.problems.length ? [] : r.value, parties: pr.problems.length ? [] : pr.value });
  }

  // ---- the small figures on each page ------------------------------------------------------------------------
  // Quiet by design: a line of facts under the input (facts() in viz.js), with an arrow where a figure is being compared, and
  // the thin ribbon on Time, Crew and Party. Nothing here asks for attention while you are typing.
  const perHourText = (cents) => (cents == null ? '—' : `${usd0(cents)}/hr`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // "▲ $6 vs your $29 average" for a rate set against another
  const versus = (rate, avg, what) => (rate == null || avg == null ? {} : { tone: rate >= avg ? 'up' : 'down', note: `${usd0(Math.abs(rate - avg))} ${rate >= avg ? 'above' : 'below'} ${what} ${usd0(avg)}` });

  function paintVisuals(shown, v) {
    if (shown === 'time') paintTime(v);
    else if (shown === 'tips') paintTips(v);
    else if (shown === 'wage') paintIncome(v);
    else if (shown === 'misc') paintMisc(v);
    else if (shown === 'location') paintPlaces();
    else if (shown === 'crew') paintLabour(v);
    else if (shown === 'party') paintParty(v);
  }

  // Time: worked, length, breaks; and the shift along the clock.
  function paintTime(v) {
    if (!v) {
      $('timeFacts').replaceChildren();
      return ribbons.time.update();
    }
    const elapsed = wallMinutes(v.S, v.E);
    const off = elapsed - v.d.paid_minutes;
    $('timeFacts').replaceChildren(facts([
      { label: 'Worked', value: hoursText(v.d.paid_minutes), hint: 'The shift’s length minus breaks: what your hourly figures use' },
      { label: 'Length', value: hoursText(elapsed) },
      off ? { label: 'Breaks', value: hoursText(off), hint: 'Unpaid' } : null,
    ]));
    ribbons.time.update({ S: v.S, E: v.E, breaks: v.breaks });
  }

  // Type: what each type has paid you before, so the choice has some context.
  function paintTypeHistory() {
    for (const el of root.querySelectorAll('[data-hist]')) {
      const b = past().byType[el.dataset.hist];
      el.textContent = b?.n ? `${plural(b.n, 'shift')} · ${perHourText(tipsPerHour(b))} in tips` : 'No shifts yet';
    }
  }

  const tipCents = () => ctx.entries.filter(isTips).reduce((a, e) => a + (parseDollars(e.value) ?? 0), 0);

  // Tips: the total, the rate, and how that rate sits against your average.
  function paintTips(v) {
    const total = tipCents();
    const minutes = v?.d.paid_minutes ?? 0;
    const rate = perHour(total, minutes);
    const items = [{ label: 'Total', value: total ? usd(total) : '—' }, { label: 'Per hour', value: perHourText(rate), ...versus(rate, tipsPerHour(past().all), 'your') }];
    if (ctx.type === 'double') {
      for (const part of ['day', 'night']) {
        const cents = ctx.entries.filter((e) => isTips(e) && e.part === part).reduce((a, e) => a + (parseDollars(e.value) ?? 0), 0);
        if (cents) items.push({ label: TYPE_NAME[part], value: usd0(cents) });
      }
    }
    $('tipFacts').replaceChildren(facts(total ? items : []));
  }

  // Wage page: the whole shift's income.
  function paintIncome(v) {
    if (!v) return $('incomeFacts').replaceChildren();
    const { d } = v;
    $('incomeFacts').replaceChildren(facts([
      { label: 'Total income', value: usd0(d.total_income_cents), hint: d.estimated_wage_cents === null ? 'Without wage: no rate applies' : 'Tips + wage + misc' },
      { label: 'Per hour', value: perHourText(d.total_per_hour_cents) },
      { label: 'Tips', value: usd0(d.tips_cents) },
      d.other_income_cents ? { label: 'Misc', value: usd0(d.other_income_cents) } : null,
    ]));
  }

  // Misc: the total, and each type.
  function paintMisc() {
    const byType = new Map();
    for (const e of ctx.entries) {
      const cents = parseDollars(e.value);
      if (!cents || isTips(e)) continue;
      byType.set(e.category_id, (byType.get(e.category_id) ?? 0) + cents);
    }
    if (!byType.size) return $('miscFacts').replaceChildren();
    $('miscFacts').replaceChildren(facts([
      { label: 'Total', value: usd([...byType.values()].reduce((a, c) => a + c, 0)) },
      ...(byType.size > 1 ? [...byType].map(([id, cents]) => ({ label: data.incomeCategories.get(id)?.name ?? 'Misc', value: usd(cents) })) : []),
    ]));
  }

  // Location: how the place typed has done for you, against all your shifts.
  function paintPlaces() {
    const typed = $('fLocation').value.trim();
    if (!typed) return $('placeFacts').replaceChildren();
    const place = [...data.locations.values()].find((l) => !l.archived && sameName(l.name, typed));
    const b = place && past().byLocation.get(place.id);
    if (!place) return $('placeFacts').replaceChildren(h('p', { class: 'muted' }, `${typed} isn’t on your list yet. It is added when you save.`));
    $('placeFacts').replaceChildren(b?.n
      ? facts([{ label: 'Here before', value: plural(b.n, 'shift') }, { label: 'Tips per hour', value: perHourText(tipsPerHour(b)), ...versus(tipsPerHour(b), tipsPerHour(past().all), 'your') }])
      : h('p', { class: 'muted' }, 'No shifts here yet.'));
  }

  // Crew: the labour on the shift, and each person against your time.
  function paintLabour(v) {
    const totals = $('staffTotals');
    if (!v || !ctx.staff.length) {
      totals.replaceChildren();
    } else {
      const { d } = v;
      totals.replaceChildren(facts([
        { label: plural(d.bartender_count, 'bartender'), value: hoursText(d.bartender_minutes) },
        { label: 'Staff tips', value: usd0(d.staff_tips_cents), hint: 'Everyone’s, yours included' },
        { label: 'Per bartender hour', value: perHourText(d.staff_tips_per_bartender_hour_cents) },
      ]));
    }
    ribbons.crew.update(v && ctx.staff.length ? { S: v.S, E: v.E, crew: ctx.staff.map((m) => ({ name: m.name, ...staffDoc(m, v.S, v.E) })) } : undefined);
  }

  // Party: how many, how many guests, and when.
  function paintParty(v) {
    $('partySection').hidden = partyList.count() === 0;
    if (!v) { $('partyFacts').replaceChildren(); return ribbons.party.update(); }
    const guests = v.parties.reduce((a, p) => a + (p.guests ?? 0), 0);
    const minutes = v.parties.reduce((a, p) => a + (p.start_at ? wallMinutes(p.start_at, p.end_at) : 0), 0);
    $('partyFacts').replaceChildren(facts([
      { label: 'Parties', value: String(v.parties.length) },
      guests ? { label: 'Guests', value: String(guests) } : null,
      minutes ? { label: 'Party time', value: hoursText(minutes) } : null,
    ]));
    ribbons.party.update({ S: v.S, E: v.E, parties: v.parties });
  }

  root.addEventListener('click', refreshDerived); // a break added or removed, a Today button...

  // ---- location and employees: tap a name, or type one ------------------------------------
  // Both are offered most recently worked first, so the usual ones are always in reach.
  function byRecent(map, idsOf) {
    const last = new Map();
    for (const s of data.shifts.values()) for (const id of idsOf(s)) if (!(last.get(id) >= s.start_at)) last.set(id, s.start_at);
    return [...map.values()]
      .filter((x) => !x.archived)
      .sort((a, b) => (last.get(b.id) ?? '').localeCompare(last.get(a.id) ?? '') || a.name.localeCompare(b.name));
  }

  const pill = (text, pressed, onClick, label) => {
    const b = h('button', { type: 'button', class: 'pill', 'aria-pressed': String(pressed), 'aria-label': label }, text);
    b.addEventListener('click', onClick);
    return b;
  };

  function renderLists() {
    if (!ctx) return;
    const typed = $('fLocation').value;
    const places = byRecent(data.locations, (s) => (s.location_id ? [s.location_id] : []));
    $('locationPills').replaceChildren(...places.slice(0, PILL_LIMIT).map((p) => pill(p.name, sameName(p.name, typed), () => {
      $('fLocation').value = sameName(p.name, $('fLocation').value) ? '' : p.name;
      $('fLocation').removeAttribute('aria-invalid');
      renderLists();
    })));
    $('locationList').replaceChildren(...places.map((p) => h('option', { value: p.name })));
    renderStaff();
  }

  // The employees on this shift: a pill each to pick them, a summary row each on the form, and the picked person's
  // detail (start, end, tips, role) in the side panel's Crew tab.
  function renderStaff() {
    const people = byRecent(data.employees, (s) => s.employees.map((e) => e.employee_id));
    const picked = (name) => ctx.staff.some((m) => sameName(m.name, name));
    const offered = people.slice(0, PILL_LIMIT).map((p) => ({ employee_id: p.id, name: p.name }));
    for (const m of ctx.staff) if (!offered.some((o) => sameName(o.name, m.name))) offered.push(m); // picked ones stay visible
    $('staffPills').replaceChildren(...offered.map((p) => pill(p.name, picked(p.name), () => toggleStaff(p), `${p.name}${picked(p.name) ? ', selected' : ''}`)));
    $('employeeList').replaceChildren(...people.filter((p) => !picked(p.name)).map((p) => h('option', { value: p.name })));
    $('staffEmpty').hidden = offered.length > 0;
    paintCrew();
    refreshDerived();
  }

  const clock = (hhmm) => { const [hh, mm] = hhmm.split(':').map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
  // The line under a person's tab: their hours and tips ("8h · $40"), or "no times".
  const crewSub = (m) => {
    const cents = m.tips.trim() === '' ? null : parseDollars(m.tips);
    const s = toMinutes(m.start);
    const e = toMinutes(m.end);
    const worked = s !== null && e !== null ? hoursText((e - s + 1440) % 1440 || 1440) : 'no times';
    return [worked, cents === null ? '' : usd0(cents)].filter(Boolean).join(' · ');
  };
  const roleText = (m) => (m.employee_id ? data.employees.get(m.employee_id)?.role : m.role) ?? '';
  let crewSerial = 0;

  // Redraw the strip of tabs (one per person on the shift) with the picked person's detail open.
  function paintCrew() {
    if (!ctx.staff.includes(ctx.crew)) ctx.crew = ctx.staff[0] ?? null; // always someone picked while anyone is on the shift
    for (const m of ctx.staff) { m.uid ??= ++crewSerial; m.detail ??= buildDetail(m); }
    for (const m of ctx.staff) m.paintRole();
    crewTabs.setItems(ctx.staff.map((m) => ({ id: m.uid, label: m.name, sub: crewSub(m), panel: m.detail })), { select: ctx.crew?.uid });
    const roles = new Set([...SUGGESTED_ROLES, ...[...data.employees.values()].map((e) => e.role).filter(Boolean)]);
    $('crewRoleList').replaceChildren(...[...roles].sort().map((r) => h('option', { value: r })));
  }

  function removeStaff(m) {
    ctx.staff.splice(ctx.staff.indexOf(m), 1);
    renderStaff();
  }

  // One person's inputs in the Crew tab: their start, end and tips on this shift, and their role. A role is the
  // person's, not the shift's, so for someone already on the table it is saved as soon as it is changed (the same as in
  // the Employees tab); for a new name it is kept and sent when the person is created on save.
  function buildDetail(m) {
    const start = h('input', { type: 'time', 'aria-label': `${m.name} start` });
    const end = h('input', { type: 'time', 'aria-label': `${m.name} end` });
    const tips = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '$0.00', 'aria-label': `${m.name}: tips they made, in dollars` });
    const role = h('input', { type: 'text', list: 'crewRoleList', maxlength: '50', autocomplete: 'off', placeholder: 'Bartender', 'aria-label': `${m.name}: role` });
    const hint = h('p', { class: 'muted' });
    const msg = h('div', { class: 'lmsg', role: 'status' });
    start.value = m.start;
    end.value = m.end;
    tips.value = m.tips;
    for (const [input, key] of [[start, 'start'], [end, 'end'], [tips, 'tips']]) {
      input.addEventListener('input', () => { m[key] = input.value; input.removeAttribute('aria-invalid'); crewTabs.setSub(m.uid, crewSub(m)); });
    }
    m.el = { start, end, tips, role };
    m.paintRole = () => { // also runs when the people list changes elsewhere; a role being typed is left alone
      if (document.activeElement !== role) role.value = roleText(m);
      hint.textContent = isBartender(roleText(m)) ? 'Counts as a bartender in the shift totals.' : 'Not counted as a bartender; their tips still count towards the shift.';
    };
    role.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); role.blur(); } });
    role.addEventListener('change', async () => {
      const value = role.value.trim();
      const person = m.employee_id ? data.employees.get(m.employee_id) : null;
      if (!person) { m.role = value; m.paintRole(); return refreshDerived(); }
      if (value === (person.role ?? '')) { role.value = person.role ?? ''; return undefined; }
      try {
        const row = await request('PATCH', `/employees/${person.id}`, { role: value === '' ? null : value });
        data.employees.set(row.id, row);
        msg.textContent = `Saved ${row.name}’s role.`;
        msg.classList.remove('bad');
        onDataChanged?.();
        m.paintRole();
        refreshDerived();
      } catch (err) {
        if (isAuthError(err)) return onAuth();
        role.value = person.role ?? '';
        msg.textContent = err.problems?.[0]?.replace(/^\w+: /, '') ?? 'Could not save that.';
        msg.classList.add('bad');
      }
      return undefined;
    });
    const remove = h('button', { type: 'button', class: 'btn btn-danger' }, 'Take off this shift');
    remove.addEventListener('click', () => removeStaff(m));
    const field = (label, input) => h('label', { class: 'field' }, label, input);
    return h('div', { class: 'crewdetail' },
      h('div', { class: 'timepair' }, field('Start', start), h('span', { class: 'to', 'aria-hidden': 'true' }, '→'), field('End', end)),
      field('Tips they made', tips), field('Role', role), hint, msg,
      h('div', null, remove));
  }

  // Someone joins the shift. Their times start as yours (most people work the same hours), and are theirs to change.
  const newStaff = (employee_id, name) => ({ employee_id, name, start: $('fStart').value, end: $('fEnd').value, tips: '', role: '', el: null, uid: ++crewSerial });

  function toggleStaff(member) {
    const at = ctx.staff.findIndex((m) => sameName(m.name, member.name));
    if (at >= 0) ctx.staff.splice(at, 1);
    else { ctx.crew = newStaff(member.employee_id ?? null, member.name); ctx.staff.push(ctx.crew); }
    renderStaff();
  }

  // Add whatever is typed in the employee box: an existing name picks that person, a new one is added to the
  // employees table when the shift is saved. A name that was removed counts as new.
  function commitEmployee() {
    const name = $('fEmployee').value.trim().replace(/,+$/, '').trim();
    $('fEmployee').value = '';
    if (!name) return;
    if (ctx.staff.some((m) => sameName(m.name, name))) return renderStaff();
    const known = [...data.employees.values()].find((c) => !c.archived && sameName(c.name, name));
    ctx.crew = newStaff(known?.id ?? null, known?.name ?? name);
    ctx.staff.push(ctx.crew);
    renderStaff();
  }
  $('fEmployee').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); commitEmployee(); }
  });
  $('fEmployee').addEventListener('change', commitEmployee); // also fires when a suggestion is picked or the box loses focus
  $('addEmployee').addEventListener('click', () => { commitEmployee(); $('fEmployee').focus(); });
  $('fLocation').addEventListener('input', renderLists);

  // ---- the party checkbox: on adds a party (an empty one is still a party), off removes them ----
  // ticking adds an empty party (that one happened is what matters); unticking removes them all
  $('fParty').addEventListener('change', () => { partyList.setPresent($('fParty').checked); refreshDerived(); });

  // ---- the live line under each tab ---------------------------------------------------------
  const TYPE_LABEL = { day: 'Day', night: 'Night', double: 'Double' };
  const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const dayLabel = (date) => { const [y, m, d] = date.split('-').map(Number); return DAY.format(new Date(Date.UTC(y, m - 1, d))); };
  const clip = (text, n) => (text.length > n ? text.slice(0, n - 1) + '…' : text);

  // `d` is the shift's derived block, or null while the date and times aren't valid yet.
  function paintSummaries(d) {
    const date = $('fDate').value;
    stepper.summarize('date', /^\d{4}-\d{2}-\d{2}$/.test(date) ? dayLabel(date) : 'Not set');
    const breaks = breakList.count();
    stepper.summarize('time', ($('fStart').value && $('fEnd').value ? `${clock($('fStart').value)} → ${clock($('fEnd').value)}` : 'Not set') + (breaks ? ` · ${breaks} break${breaks === 1 ? '' : 's'}` : ''));
    stepper.summarize('type', TYPE_LABEL[ctx.type] ?? 'Not chosen');
    let tips = 0;
    let other = 0;
    for (const e of ctx.entries) {
      const cents = parseDollars(e.value);
      if (!cents) continue;
      if (isTips(e)) tips += cents; else other += cents;
    }
    stepper.summarize('tips', tips ? usd0(tips) : 'None');
    stepper.summarize('wage', d ? (d.estimated_wage_cents === null ? 'No rate set' : usd0(d.estimated_wage_cents)) : '—');
    stepper.summarize('misc', other ? usd0(other) : 'None');
    stepper.summarize('location', $('fLocation').value.trim() || 'Not set');
    const n = ctx.staff.length;
    stepper.summarize('crew', n ? `${n} ${n === 1 ? 'person' : 'people'}` + (d ? ` · ${d.bartender_count} bartender${d.bartender_count === 1 ? '' : 's'}` : '') : 'Just you');
    const parties = partyList.summary();
    stepper.summarize('party', parties.length ? parties.join('; ') : 'No party');
    const notes = $('fNotes').value.trim();
    stepper.setMeta([/^\d{4}-\d{2}-\d{2}$/.test(date) ? dayLabel(date) : '', TYPE_LABEL[ctx.type] ?? '', d ? usd0(d.total_income_cents) + ' total' : ''].filter(Boolean).join(' · '));
    stepper.summarize('notes', notes ? clip(notes, 28) : $('fTags').value.trim() ? clip($('fTags').value.trim(), 28) : 'None');
  }

  // A dot on every tab that holds a field with a problem.
  function syncFlags() {
    const names = new Set();
    for (const el of document.querySelectorAll(INVALID)) {
      const name = el.closest('[role="tabpanel"][data-tab]')?.dataset.tab;
      if (name) names.add(name);
    }
    stepper.flag(names);
    for (const tabs of [breakList.tabs, partyList.tabs, crewTabs]) tabs.flag();
  }

  // ---- reading the form --------------------------------------------------------------
  function read() {
    const problems = [];
    const bad = (el, msg) => problems.push({ el, msg });

    const date = $('fDate').value;
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);
    if (!dateOk) bad($('fDate'), 'Enter the shift date.');
    const startOk = toMinutes($('fStart').value) !== null;
    const endOk = toMinutes($('fEnd').value) !== null;
    if (!startOk) bad($('fStart'), 'Enter a start time.');
    if (!endOk) bad($('fEnd'), 'Enter an end time.');

    // The shift's own span, and the breaks inside it (they need the span, so only when the times are valid).
    let S = null;
    let E = null;
    let breaks = [];
    let parties = [];
    const employees = [];
    if (dateOk && startOk && endOk) {
      S = joinLocal(addDays(date, ctx.startDelta), toMinutes($('fStart').value));
      E = resolveEnd(S, $('fEnd').value); // an end at or before the start means the next day
      const r = breakList.read({ S, E });
      for (const p of r.problems) bad(p.el, p.msg);
      breaks = r.value;
      const pr = partyList.read({ S, E });
      for (const p of pr.problems) bad(p.el, p.msg);
      parties = pr.value;
      // each employee's times sit on the dates nearest the shift (they may arrive earlier or leave later than you)
      for (const m of ctx.staff) {
        let start_at = null;
        let end_at = null;
        if (m.start || m.end) {
          if (!m.start || !m.end) bad(m.start ? m.el.end : m.el.start, `${m.name}: enter both a start and an end time, or neither.`);
          else { start_at = resolveNearSpan(S, E, m.start); end_at = resolveEnd(start_at, m.end); }
        }
        let tips_cents = null;
        if (m.tips.trim() !== '') {
          tips_cents = parseDollars(m.tips);
          if (tips_cents === null) bad(m.el.tips, `${m.name}: enter their tips like 40 or 12.50.`);
        }
        employees.push({ employee_id: m.employee_id ?? null, start_at, end_at, tips_cents });
      }
    }

    if (!ctx.type) bad($('typeSeg'), 'Choose the shift type: Day, Night or Double.');

    const entries = [];
    ctx.entries.forEach((e, i) => {
      if (e.value.trim() === '' && !e.id) return; // an empty new row is just skipped
      const cents = parseDollars(e.value);
      if (cents === null) return bad(e.el?.value, `Income entry ${i + 1}: enter an amount like 12.50.`);
      entries.push({ e, cents });
    });

    const location = $('fLocation').value.trim();
    if (problems.length) return { problems };

    const doc = {
      job_id: ctx.orig?.job_id ?? null, // the form doesn't ask for a job, but editing must not drop one
      work_date: date,
      start_at: S,
      end_at: E,
      shift_type: ctx.type,
      breaks,
      parties,
      employees,
      notes: orNull($('fNotes').value),
      tags: [...new Set($('fTags').value.split(',').map((t) => t.trim()).filter(Boolean))],
      money_entries: entries.map(({ e, cents }) => ({
        ...(e.id && { id: e.id }),
        ...(e.category_id && { category_id: e.category_id }),
        value_cents: cents,
        part: ctx.type === 'double' ? e.part || null : ctx.type, // null on a double = combined / not sure
      })),
    };
    return { doc, location, problems };
  }

  // Names that aren't on a list yet are added to it now. Adding is find-or-create on the server, so a
  // retry after a failed save (or a name that was archived) is safe.
  async function addToList(path, map, name) {
    const row = await request('POST', path, { name });
    map.set(row.id, row);
    return row.id;
  }

  async function resolveLists(doc, location) {
    let location_id = null;
    if (location) {
      const kept = ctx.loadedLocation && sameName(ctx.loadedLocation.name, location) ? ctx.loadedLocation.id : null; // unchanged: no need to re-add
      const known = [...data.locations.values()].find((l) => !l.archived && sameName(l.name, location));
      location_id = kept ?? known?.id ?? (await addToList('/locations', data.locations, location));
    }
    // new employee names are added to the employees table first, so each staff row has an id
    for (const member of ctx.staff) {
      if (member.employee_id) continue;
      const row = await request('POST', '/employees', { name: member.name, ...(member.role && { role: member.role }) });
      data.employees.set(row.id, row);
      member.employee_id = row.id;
    }
    return { ...doc, location_id, employees: doc.employees.map((e, i) => ({ ...e, employee_id: ctx.staff[i].employee_id })) };
  }

  // ---- saving and deleting -----------------------------------------------------------
  async function save() {
    if (!ctx || ctx.saving) return;
    commitEmployee(); // a name still sitting in the box counts
    const { doc, location, problems } = read();
    if (problems.length) return showProblems(problems);
    ctx.saving = true;
    setBusy(true);
    hideProblems();
    try {
      const shift = await request('PUT', `/shifts/${ctx.id}`, await resolveLists(doc, location));
      close();
      onSaved(shift);
    } catch (err) {
      if (isAuthError(err)) { close(); onAuth(); return; }
      const list = err.problems?.length ? err.problems : [err.message || 'Could not save.'];
      showProblems(list.map((msg) => ({ msg: friendly(msg) })));
    } finally {
      if (ctx) ctx.saving = false;
      setBusy(false);
    }
  }

  let armTimer = null;
  function disarm() {
    clearTimeout(armTimer);
    if (ctx) ctx.armed = false;
    $('deleteShift').textContent = 'Delete';
  }

  async function remove() {
    if (!ctx || ctx.mode !== 'edit') return;
    if (!ctx.armed) { // two clicks, so a stray tap can't delete
      ctx.armed = true;
      $('deleteShift').textContent = 'Click again to delete';
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    ctx.saving = true;
    setBusy(true);
    try {
      await request('DELETE', `/shifts/${ctx.id}`);
      const shift = await request('GET', `/shifts/${ctx.id}`);
      close();
      onSaved(shift);
    } catch (err) {
      if (isAuthError(err)) { close(); onAuth(); return; }
      showProblems([{ msg: friendly(err.problems?.[0] ?? err.message ?? 'Could not delete.') }]);
    } finally {
      if (ctx) ctx.saving = false;
      setBusy(false);
      disarm();
    }
  }

  // ---- messages, busy state, closing ------------------------------------------------
  function showProblems(list) {
    const box = $('formErrors');
    for (const el of document.querySelectorAll(INVALID)) el.removeAttribute('aria-invalid');
    for (const { el } of list) el?.setAttribute('aria-invalid', 'true');
    revealProblem(list.find(({ el }) => el)?.el);
    syncFlags();
    box.replaceChildren(h('ul', null, list.map(({ msg }) => h('li', null, msg))));
    box.dataset.fixable = list.every(({ el }) => el) ? '1' : ''; // every problem points at a field, so fixing them all clears the box
    box.hidden = false;
    box.focus();
  }
  function hideProblems() {
    $('formErrors').hidden = true;
    for (const el of document.querySelectorAll(INVALID)) el.removeAttribute('aria-invalid');
    syncFlags();
  }
  // A problem in a field on another tab: bring that tab up, on the right person if it is a crew member's.
  function revealProblem(el) {
    stepper.reveal(el);
    for (const tabs of [breakList.tabs, partyList.tabs, crewTabs]) if (tabs.reveal(el)) break;   // and the break, party or person it is in
  }
  function showBanner(text) {
    $('formBanner').textContent = text;
    $('formBanner').hidden = !text;
  }
  function setBusy(busy) {
    $('saveShift').disabled = busy;
    $('deleteShift').disabled = busy;
  }
  function close() {
    if (!ctx) return;
    const opener = ctx.opener;
    disarm();
    ctx = null;
    disarmClose();
    stepper.close(); // back to the browse page underneath
    onShiftDate?.(null);
    if (opener) document.querySelector(opener)?.focus();
  }

  // Closing (Close, the Shifts crumb, Esc) throws typed changes away, so the first ask when there are some turns the button
  // into "Discard changes?" for a few seconds, the same two clicks as Delete.
  let discardTimer = null;
  function disarmClose() {
    clearTimeout(discardTimer);
    if (ctx) ctx.discardArmed = false;
    $('closeForm').textContent = 'Close';
    $('closeForm').classList.remove('armed');
  }
  function requestClose() {
    if (!ctx || ctx.saving) return;
    if (!ctx.dirty || ctx.discardArmed) return close();
    ctx.discardArmed = true;
    $('closeForm').textContent = 'Discard changes?';
    $('closeForm').classList.add('armed');
    $('closeForm').focus();
    discardTimer = setTimeout(disarmClose, 4000);
    return undefined;
  }
  stepper.onCancel(requestClose);
  document.addEventListener('steppaint', () => { if (ctx) refreshDerived(); }); // a page was switched to: draw its numbers now
  $('shiftForm').addEventListener('submit', (ev) => { ev.preventDefault(); save(); });
  $('closeForm').addEventListener('click', requestClose);
  $('crumbShifts').addEventListener('click', requestClose);
  // any button that changes the shift (adding a break, picking someone, removing tips…) counts as a change
  root.addEventListener('click', (ev) => {
    if (ctx && ev.target.closest('button') && !ev.target.closest('[role="tab"], [data-step], #closeForm, #crumbShifts, .cal button')) ctx.dirty = true;
  });
  $('deleteShift').addEventListener('click', remove);
  const edited = (ev) => {
    if (ctx) ctx.dirty = true;
    refreshDerived();
    ev.target.removeAttribute?.('aria-invalid');
    const box = $('formErrors');
    if (box.dataset.fixable && !document.querySelector(INVALID)) box.hidden = true; // nothing left to fix
    syncFlags();
  };
  root.addEventListener('input', edited);
  root.addEventListener('change', edited); // a radio's own change handler has already cleared its group by the time this runs

  return {
    openNew,
    openEdit,
    // The lists changed (edited in the lists dialog, or by another device): refresh what is offered, keeping what was typed.
    listsChanged() {
      if (!ctx) return;
      renderLists();
      renderEntries();
    },
    // Called when a shift changes elsewhere (live feed) so an open form can warn instead of silently overwriting.
    noteChanged(id, shift) {
      if (!ctx || ctx.id !== id || ctx.saving || ctx.mode !== 'edit') return;
      if (shift && shift.updated_at <= ctx.baseline) return;
      if (shift) ctx.baseline = shift.updated_at;
      showBanner(shift
        ? `Changed elsewhere at ${new Date().toLocaleTimeString()}. Saving will overwrite those changes.`
        : 'This shift was permanently deleted elsewhere. Saving will create it again.');
    },
  };
}
