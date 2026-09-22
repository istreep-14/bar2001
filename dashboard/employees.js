// The employees section: the people you work with as a table of their own, sortable, one row per person. The side
// panel is whoever is picked: a profile form (name, first/last, id number, roles, manager, is-me, notes; each field
// saved on its own through PATCH /employees/:id) over their activity (the same figures in full, and their latest
// shifts). Everything goes through the public API, and the rows it changes are put into `data` straight away so the
// shift form and the shift table update without waiting for the live feed.
//
// The figures come from GET /employees/summary and are derived on the server on every read, never stored; they are
// refetched when a shift changes. The view is the Employees tab. (The shift form has its own quick single-role field
// for a crew member; full multi-role editing happens here.)
import { wallMinutes } from '/time.js';
import { hoursText, isBartender } from '/pay.js';

export const SUGGESTED_ROLES = ['Bartender', 'Barback', 'Server', 'Host', 'Bouncer', 'Manager'];

export function createEmployeesManager({ h, request, data, isAuthError, onAuth, onChange, format }) {
  const { dateLabel, usd, usd0 } = format;
  const $ = (id) => document.getElementById(id);
  const page = $('employeesPage');
  const root = $('employeesView');
  const narrow = matchMedia('(max-width: 1100px)'); // the side panel sits under the roster
  let shown = false;        // is the Employees tab showing
  let selected = null;      // id of the person in the side panel
  let summary = new Map();  // employee_id -> row of /employees/summary (nobody who never worked is in it)
  let recent = [];          // the selected person's latest shifts
  let armed = false;
  let armTimer = null;
  let summarySeq = 0;
  let recentSeq = 0;
  let refreshTimer = null;
  let sort = { key: 'name', dir: 1 };

  const isShown = () => shown;
  const dash = () => h('span', { class: 'muted' }, '—');

  function say(id, text, bad = false) {
    const box = $(id);
    box.textContent = text;
    box.classList.toggle('bad', bad);
  }
  const rosterMsg = (text, bad) => say('rosterMsg', text, bad);
  const sideMsg = (text, bad) => say('sideMsg', text, bad);

  // ---- the roster (main tier): a flat table, sortable by clicking a header ------------------
  const people = () => [...data.employees.values()].filter((e) => !e.archived);

  function totals(p) {
    const s = summary.get(p.id);
    return s
      ? { shifts: s.shifts, minutes: s.minutes, timed: s.timed_shifts, tips: s.tips_cents, tipped: s.tipped_shifts }
      : { shifts: 0, minutes: 0, timed: 0, tips: 0, tipped: 0 };
  }

  function sortValue(p, key) {
    const s = summary.get(p.id);
    switch (key) {
      case 'roles': return p.roles.join(', ').toLowerCase();
      case 'shifts': return s?.shifts ?? 0;
      case 'hours': return s?.minutes ?? 0;
      case 'tips': return s?.tips_cents ?? 0;
      case 'last': return s?.last_worked ?? '';
      default: return p.name.toLowerCase();
    }
  }

  function sortedPeople() {
    const { key, dir } = sort;
    return [...people()].sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return (cmp || a.name.localeCompare(b.name)) * dir;
    });
  }

  // The figure cells every row shares. Hours and tips are a dash until someone entered times or tips; the hover
  // title says when a figure is only part of the picture.
  function figureCells({ shifts, minutes, timed, tips, tipped }, last) {
    return [
      h('td', { class: 'num', 'data-label': 'Shifts' }, shifts ? String(shifts) : dash()),
      h('td', { class: 'num', 'data-label': 'Hours', title: timed && timed < shifts ? `From the ${timed} of ${shifts} shifts that have their times` : null }, timed ? hoursText(minutes) : dash()),
      h('td', { class: 'num', 'data-label': 'Tips', title: tipped ? usd(tips) + (tipped < shifts ? ` (${tipped} of ${shifts} shifts have tips entered)` : '') : null }, tipped ? usd0(tips) : dash()),
      h('td', { class: 'num hide-sm', 'data-label': 'Last worked' }, last ? dateLabel(last) : dash()),
    ];
  }

  function personRow(p) {
    const on = p.id === selected;
    const s = summary.get(p.id);
    return h('tr', { class: 'person' + (on ? ' selected' : ''), 'data-id': p.id },
      h('td', null, h('button', { type: 'button', class: 'rowbtn', 'data-id': p.id, 'aria-current': on ? 'true' : null },
        p.name,
        p.is_me ? h('span', { class: 'badge badge-me', title: 'This is you' }, 'You') : null,
        p.manager ? h('span', { class: 'badge badge-mgr', title: 'Manager' }, 'Mgr') : null)),
      h('td', { class: 'roles-cell', title: p.roles.join(', ') || null }, p.roles.length ? p.roles.join(', ') : dash()),
      ...figureCells(totals(p), s?.last_worked ?? null));
  }

  function renderSortHeads() {
    for (const btn of root.querySelectorAll('#rosterHead [data-sort]')) {
      const active = btn.dataset.sort === sort.key;
      btn.closest('th').setAttribute('aria-sort', active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
      btn.classList.toggle('sorted', active);
    }
  }

  function renderRoster() {
    const list = sortedPeople();
    const active = document.activeElement;
    const refocus = active?.classList?.contains('rowbtn') ? active.dataset.id : null;   // the table is rebuilt on every change
    $('rosterRows').replaceChildren(...list.map(personRow));
    if (refocus) root.querySelector(`.rowbtn[data-id="${CSS.escape(refocus)}"]`)?.focus();
    $('rosterScroll').hidden = list.length === 0;
    $('employeesEmpty').hidden = list.length > 0;
    renderSortHeads();
    const roles = new Set([...SUGGESTED_ROLES, ...[...data.employees.values()].flatMap((e) => e.roles)]);
    $('roleList').replaceChildren(...[...roles].sort().map((r) => h('option', { value: r })));
  }

  // ---- the side panel (second tier): profile form, then activity ---------------------------
  function renderStats(p) {
    const s = summary.get(p.id);
    const avg = s?.tipped_shifts ? Math.round(s.tips_cents / s.tipped_shifts) : null;
    const tiles = [
      ['Shifts', String(s?.shifts ?? 0), ''],
      ['Hours', s?.timed_shifts ? hoursText(s.minutes) : '—', s && s.timed_shifts && s.timed_shifts < s.shifts ? `${s.timed_shifts} of ${s.shifts} shifts have times` : ''],
      ['Tips', s?.tipped_shifts ? usd(s.tips_cents) : '—', s && s.tipped_shifts && s.tipped_shifts < s.shifts ? `${s.tipped_shifts} of ${s.shifts} shifts have tips` : ''],
      ['Avg per tipped shift', avg === null ? '—' : usd(avg), ''],
      ['First shift', s?.first_worked ? dateLabel(s.first_worked) : '—', ''],
      ['Latest shift', s?.last_worked ? dateLabel(s.last_worked) : '—', ''],
    ];
    $('sideStats').replaceChildren(...tiles.map(([label, value, note]) =>
      h('div', { class: 'stat' }, h('dt', null, label), h('dd', null, value), note ? h('span', { class: 'muted' }, note) : null)));
  }

  function renderRecent() {
    const items = recent.map((s) => {
      const e = s.employees.find((x) => x.employee_id === selected);
      const detail = [e?.start_at ? hoursText(wallMinutes(e.start_at, e.end_at)) : 'no times', e?.tips_cents != null ? usd(e.tips_cents) + ' tips' : ''].filter(Boolean).join(' · ');
      return h('li', { class: 'rshift' },
        h('span', { class: 'rwhen' }, s.work_date ? dateLabel(s.work_date) : 'No date', s.shift_type ? h('span', { class: 'badge badge-' + s.shift_type }, s.shift_type) : null),
        h('span', { class: 'muted' }, detail));
    });
    $('sideShifts').replaceChildren(...items);
    $('sideShiftsEmpty').hidden = items.length > 0;
  }

  // A role chip with its own remove button.
  function chip(role) {
    const remove = h('button', { type: 'button', class: 'chipx', 'aria-label': `Remove role ${role}` });
    remove.textContent = '×';
    remove.addEventListener('click', () => saveRoles(currentRoles().filter((r) => r !== role)));
    return h('span', { class: 'chip' }, role, remove);
  }

  const currentRoles = () => (selected && data.employees.get(selected)?.roles) ?? [];

  // The roles chip field: existing roles as removable chips, then a trailing text input that commits a new chip
  // on Enter/comma/blur, or pops the last chip on Backspace when it's empty. Left alone while it has focus (like
  // pName/pNotes below), so a role being typed can't be wiped out from under the cursor by a background refresh.
  function renderChips({ force = false } = {}) {
    if (!force && document.activeElement?.id === 'pRolesInput') return;
    const roles = currentRoles();
    const input = h('input', { id: 'pRolesInput', list: 'roleList', maxlength: '50', autocomplete: 'off', placeholder: roles.length ? 'Add a role' : 'Bartender', 'aria-label': 'Add a role' });
    const commit = () => {
      const value = input.value.trim();
      input.value = '';
      if (value && !roles.includes(value)) saveRoles([...roles, value]);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Backspace' && !input.value && roles.length) saveRoles(roles.slice(0, -1));
    });
    input.addEventListener('blur', commit);
    $('pRoles').replaceChildren(...roles.map(chip), input);
  }

  // `force` overwrites the profile fields even under the cursor (a different person was picked); otherwise the field
  // being typed in is left alone, so a live update can't eat an edit.
  function renderSide({ force = false } = {}) {
    const p = selected && data.employees.get(selected);
    if (!p || p.archived) {
      selected = null;
      $('sideEmpty').hidden = false;
      $('sideDetail').hidden = true;
      return;
    }
    $('sideEmpty').hidden = true;
    $('sideDetail').hidden = false;
    $('sideName').textContent = p.name;
    for (const [id, value] of [['pName', p.name], ['pFirst', p.first ?? ''], ['pLast', p.last ?? ''], ['pIdNumber', p.id_number ?? ''], ['pNotes', p.notes ?? '']]) {
      if (force || document.activeElement !== $(id)) $(id).value = value;
    }
    if (document.activeElement !== $('pManager')) $('pManager').checked = p.manager;
    if (document.activeElement !== $('pIsMe')) $('pIsMe').checked = p.is_me;
    renderChips({ force });
    $('roleHint').textContent = isBartender(p.roles)
      ? 'Counts as a bartender in a shift’s totals.'
      : 'Not counted as a bartender in a shift’s totals; their tips still count towards the shift.';
    $('removeEmployee').textContent = armed ? 'Click again to remove' : 'Remove ' + p.name;
    $('removeEmployee').classList.toggle('armed', armed);
    renderStats(p);
    renderRecent();
  }

  const render = () => { renderRoster(); renderSide(); };

  // ---- talking to the server -------------------------------------------------------------
  // Errors from something the person did are shown in `report`; from a background refresh, only a lost login matters.
  async function call(fn, fail = undefined, report = sideMsg) {
    try {
      return await fn();
    } catch (err) {
      if (isAuthError(err)) { onAuth(); return fail; }
      report(err.problems?.[0]?.replace(/^\w+: /, '') ?? err.message ?? 'Could not save that.', true);
      return fail;
    }
  }
  async function background(fn) {
    try {
      return await fn();
    } catch (err) {
      if (isAuthError(err)) onAuth();
      return null;
    }
  }

  async function refreshSummary() {
    const seq = ++summarySeq;
    const res = await background(() => request('GET', '/employees/summary'));
    if (!res || seq !== summarySeq) return; // a newer request is on its way
    summary = new Map(res.summary.map((r) => [r.employee_id, r]));
    renderRoster();
    if (selected) renderSide();
  }

  async function loadRecent() {
    const id = selected;
    if (!id || !isShown()) return;
    const seq = ++recentSeq;
    const res = await background(() => request('GET', `/shifts?employee_id=${encodeURIComponent(id)}&limit=8`));
    if (!res || seq !== recentSeq || id !== selected) return;
    recent = res.shifts;
    renderRecent();
  }

  // ---- doing things ----------------------------------------------------------------------
  function disarm() {
    clearTimeout(armTimer);
    armed = false;
  }

  function select(id) {
    if (id === selected) return;
    selected = id;
    disarm();
    recent = [];
    sideMsg('');
    renderRoster();
    renderSide({ force: true });
    loadRecent();
    if (narrow.matches) $('employeeSide').scrollIntoView({ block: 'start' });
  }

  async function save(field, input) {
    const person = selected && data.employees.get(selected);
    if (!person) return;
    const value = input.value.trim();
    if (value === (person[field] ?? '')) { input.value = person[field] ?? ''; return; }
    if (field === 'name' && !value) { input.value = person.name; return sideMsg('A name can’t be empty.', true); }
    const row = await call(() => request('PATCH', `/employees/${person.id}`, { [field]: value === '' ? null : value }));
    if (!row) { input.value = person[field] ?? ''; return; }
    data.employees.set(row.id, row);
    sideMsg(field === 'name' ? `Renamed to “${row.name}”. Past shifts show the new name.` : `Saved ${row.name}.`);
    onChange();
    render();
  }

  async function saveRoles(roles) {
    const person = selected && data.employees.get(selected);
    if (!person) return;
    const row = await call(() => request('PATCH', `/employees/${person.id}`, { roles }));
    if (!row) return;
    data.employees.set(row.id, row);
    sideMsg(`Saved ${row.name}.`);
    onChange();
    render();
  }

  async function saveFlag(field, input) {
    const person = selected && data.employees.get(selected);
    if (!person) return;
    const value = input.checked;
    if (value === !!person[field]) return;
    const row = await call(() => request('PATCH', `/employees/${person.id}`, { [field]: value }));
    if (!row) { input.checked = !!person[field]; return; }
    data.employees.set(row.id, row);
    sideMsg(`Saved ${row.name}.`);
    onChange();
    render();
  }

  async function drop() {
    const person = selected && data.employees.get(selected);
    if (!person) return;
    disarm();
    const result = await call(() => request('DELETE', `/employees/${person.id}`), null, rosterMsg);
    if (result === null) return renderSide();
    if (result.archived) data.employees.set(person.id, { ...person, archived: true });
    else data.employees.delete(person.id);
    selected = null;
    rosterMsg(result.archived ? `Removed “${person.name}”. Past shifts keep them; add the name again to bring them back.` : `Removed “${person.name}”.`);
    onChange();
    render();
    $('newEmployeeName').focus();
  }

  async function add() {
    const name = $('newEmployeeName').value.trim();
    if (!name) return $('newEmployeeName').focus();
    const role = $('newEmployeeRole').value.trim();
    const existed = people().some((p) => p.name.toLowerCase() === name.toLowerCase());
    const row = await call(() => request('POST', '/employees', { name, ...(role && { roles: [role] }) }), undefined, rosterMsg);
    if (!row) return;
    data.employees.set(row.id, row);
    $('newEmployeeName').value = '';
    $('newEmployeeRole').value = '';
    rosterMsg(existed ? `“${row.name}” is already on your list.` : `Added “${row.name}”.`);
    onChange();
    render();
    select(row.id);
    $('newEmployeeName').focus();
  }

  // ---- wiring ----------------------------------------------------------------------------
  $('rosterRows').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr.person');
    if (tr) select(tr.dataset.id);
  });
  $('rosterHead').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-sort]');
    if (!btn) return;
    const key = btn.dataset.sort;
    sort = { key, dir: sort.key === key ? -sort.dir : 1 };
    renderRoster();
  });
  for (const [id, field] of [['pName', 'name'], ['pFirst', 'first'], ['pLast', 'last'], ['pIdNumber', 'id_number'], ['pNotes', 'notes']]) {
    const el = $(id);
    el.addEventListener('change', () => save(field, el));
    el.addEventListener('keydown', (ev) => {
      const person = selected && data.employees.get(selected);
      if (ev.key === 'Enter' && el.tagName === 'INPUT') el.blur(); // commits through the change event
      if (ev.key === 'Escape' && person && el.value !== (person[field] ?? '')) { ev.preventDefault(); el.value = person[field] ?? ''; } // undo the edit, not the dialog
    });
  }
  $('pManager').addEventListener('change', () => saveFlag('manager', $('pManager')));
  $('pIsMe').addEventListener('change', () => saveFlag('is_me', $('pIsMe')));
  $('removeEmployee').addEventListener('click', () => {
    if (armed) return void drop();
    armed = true;
    armTimer = setTimeout(() => { armed = false; renderSide(); }, 4000);
    renderSide();
  });
  $('addEmployeeBtn').addEventListener('click', add);
  for (const id of ['newEmployeeName', 'newEmployeeRole']) $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
  function reveal() {
    rosterMsg('');
    render();
    refreshSummary();
    loadRecent();
  }

  return {
    // The Employees tab: show or hide the view.
    show() { shown = true; page.hidden = false; reveal(); },
    hide() { shown = false; page.hidden = true; },
    // A person was added, changed or removed elsewhere: redraw (a field being typed in is left alone).
    changed() {
      if (isShown()) render();
    },
    // A shift changed: the figures are stale, so fetch them again shortly (a burst of changes is one fetch).
    shiftsChanged() {
      if (!isShown()) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { refreshSummary(); loadRecent(); }, 300);
    },
  };
}
