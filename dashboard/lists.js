// The lists behind the shift form: locations, misc types (the other-income kinds) and wage rates. Each is edited on the
// page it feeds while a shift is open (locations on Location, misc types on Misc, wage rates on Wage), and on a page of
// its own in the Lists group while browsing. An editor is built into every element marked data-list, so the same code
// serves both. Add, rename and remove the names the form offers as autofill, and edit the wage history, which reads as
// date ranges: a rate applies from its start date until the day before the next one starts, and the range that applies
// to the shift being edited is marked. Everything goes through the public API, and the rows it changes are put into
// `data` straight away so the form and the shift table update without waiting for the live feed.
import { parseDollars } from '/form.js';
import { addDays } from '/time.js';
import { rateOn } from '/pay.js';

// `path` is the API path; `key` is where the page keeps the rows (state.<key>).
const KINDS = {
  locations: { path: '/locations', key: 'locations', noun: 'location', add: 'Add a location…', plural: 'locations', blurb: 'Places you work. Pick one on a shift, or type a new name there and it is added here.' },
  income_categories: { path: '/income-categories', key: 'incomeCategories', noun: 'misc type', add: 'Add a misc type…', plural: 'misc types', blurb: 'The kinds of income besides tips and wage, like Cash, Venmo or Paycheck. Log them on a shift under Misc.' },
  wage_rates: { path: '/wage-rates', key: 'wageRates', rates: true, noun: 'rate', plural: 'wage rates', blurb: 'Your hourly wage, used to estimate what each shift earned: paid time (breaks are unpaid) times the rate. A rate applies from its start date until the next one starts.' },
};

const dollars = (cents) => (cents / 100).toFixed(2);
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dayText = (date) => DAY.format(new Date(`${date}T00:00:00Z`));

export function createListsManager({ h, request, data, side, isAuthError, onAuth, onChange }) {
  const editors = [...document.querySelectorAll('[data-list]')].map((mount) => createEditor(mount.dataset.list, KINDS[mount.dataset.list], mount));
  return {
    // Show the page where `kind` is edited in the current mode and put the cursor where you add.
    open(kind) {
      const editor = editors.find((e) => e.kind === kind && side.has(e.tab));
      if (!editor) return;
      side.show(editor.tab);
      editor.focus();
    },
    // The date of the shift being edited (or null): the wage range that applies to it is marked.
    setShiftDate(date) {
      for (const editor of editors) editor.setDate?.(date);
    },
    // A list changed (here, or elsewhere): redraw, unless someone is in the middle of typing a rename.
    changed() {
      for (const editor of editors) editor.refresh();
    },
  };

  function createEditor(kind, spec, mount) {
    const isRates = !!spec.rates;
    const map = () => data[spec.key];
    const tab = mount.closest('[role="tabpanel"]').dataset.tab; // the page this editor is on
    let shiftDate = null;

    const rows = h('ul', { class: 'lrows' });
    const empty = h('div', { class: 'muted' });
    const msg = h('div', { class: 'lmsg', role: 'status' });
    const nameInput = h('input', { maxlength: '100', autocomplete: 'off', placeholder: spec.add, 'aria-label': `New ${spec.noun} name` });
    const rateDate = h('input', { type: 'date', 'aria-label': 'New rate starts on' });
    const rateAmount = h('input', { class: 'amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '$/hr', 'aria-label': 'New hourly rate in dollars' });
    const addButton = h('button', { type: 'button', class: 'btn' }, 'Add');
    const adder = h('div', { class: 'addrow' }, ...(isRates ? [rateDate, rateAmount] : [nameInput]), addButton);
    const first = isRates ? rateAmount : nameInput;
    mount.replaceChildren(...(mount.dataset.title ? [h('h3', null, mount.dataset.title)] : []), h('p', { class: 'muted lblurb' }, spec.blurb), rows, empty, adder, msg);

    function say(text, bad = false) {
      msg.textContent = text;
      msg.classList.toggle('bad', bad);
    }

    function render() {
      let items;
      if (isRates) {
        rateDate.value ||= new Date().toLocaleDateString('en-CA');
        items = [...map().values()].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1)); // newest first
        empty.textContent = 'No wage rates yet: add your hourly wage to see what each shift earned.';
      } else {
        items = [...map().values()].filter((x) => !x.archived && !x.system) // Tips is built in and isn't "other" income
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      empty.hidden = items.length > 0;
      if (!isRates) empty.textContent = `No ${spec.plural} yet.`;
      rows.replaceChildren(...items.map((item, i) => (isRates ? rateRow(item, items[i - 1], appliesId()) : row(item))));
    }

    function row(item) {
      const input = h('input', { type: 'text', value: item.name, maxlength: '100', autocomplete: 'off', 'aria-label': `Rename ${item.name}` });
      const remove = h('button', { type: 'button', class: 'linkbtn', 'aria-label': `Remove ${item.name}` }, 'Remove');
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } // commits through the change event
        if (ev.key === 'Escape' && input.value !== item.name) { ev.preventDefault(); input.value = item.name; } // undo the edit
      });
      input.addEventListener('change', () => rename(item, input));
      remove.addEventListener('click', () => drop(item));
      return h('li', { class: 'lrow' }, input, remove);
    }

    const appliesId = () => (shiftDate ? rateOn([...map().values()], shiftDate)?.id ?? null : null);

    // A wage rate: the date it starts and the dollars per hour, either editable in place, and under them the range it
    // covers: through the day before the next rate starts (`newer`, the row above), or from then on.
    function rateRow(item, newer, applies) {
      const from = h('input', { type: 'date', value: item.effective_from, 'aria-label': `Rate of ${dollars(item.rate_cents)} starts on` });
      const amount = h('input', { type: 'text', class: 'amount', inputmode: 'decimal', value: dollars(item.rate_cents), autocomplete: 'off', 'aria-label': `Hourly rate starting ${item.effective_from}, in dollars` });
      const remove = h('button', { type: 'button', class: 'linkbtn', 'aria-label': `Remove the rate starting ${item.effective_from}` }, 'Remove');
      from.addEventListener('change', () => editRate(item, { effective_from: from.value }, () => { from.value = item.effective_from; }));
      amount.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); amount.blur(); } });
      amount.addEventListener('change', () => {
        const cents = parseDollars(amount.value);
        if (cents === null) { amount.value = dollars(item.rate_cents); return say('Enter the hourly rate like 11.25.', true); }
        return editRate(item, { rate_cents: cents }, () => { amount.value = dollars(item.rate_cents); });
      });
      remove.addEventListener('click', () => drop(item, `Removed the rate from ${item.effective_from}.`));
      const range = newer ? `Applies through ${dayText(addDays(newer.effective_from, -1))}` : 'Applies from then on';
      return h('li', { class: 'lrow wrow' + (item.id === applies ? ' here' : '') }, from, h('span', { class: 'lead' }, '$'), amount, h('span', { class: 'per' }, '/hr'), remove,
        h('span', { class: 'wrange' }, range, item.id === applies ? h('span', { class: 'badge badge-here' }, 'This shift') : null));
    }

    // Runs an API call; on failure shows the server's plain-words problem and answers `fail`.
    async function call(fn, fail = undefined) {
      try {
        return await fn();
      } catch (err) {
        if (isAuthError(err)) { onAuth(); return fail; }
        say(err.problems?.[0]?.replace(/^\w+: /, '') ?? err.message ?? 'Could not save that.', true);
        return fail;
      }
    }

    async function rename(item, input) {
      const name = input.value.trim();
      if (name === item.name) { input.value = item.name; return; }
      if (!name) { input.value = item.name; return say('A name can’t be empty.', true); }
      const row = await call(() => request('PATCH', `${spec.path}/${item.id}`, { name }));
      if (!row) { input.value = item.name; return undefined; }
      map().set(row.id, row);
      say(`Renamed to “${row.name}”. Past shifts show the new name.`);
      onChange();
      render();
      return undefined;
    }

    async function editRate(item, patch, revert) {
      if (patch.effective_from === '') { revert(); return say('Choose the date the rate starts.', true); }
      const row = await call(() => request('PATCH', `${spec.path}/${item.id}`, patch));
      if (!row) return revert();
      map().set(row.id, row);
      say('Saved. Shifts on and after that date are re-estimated.');
      onChange();
      render();
      return undefined;
    }

    async function drop(item, done) {
      // a name list answers { archived }, a wage rate answers nothing (204); null means the call failed
      const result = await call(() => request('DELETE', `${spec.path}/${item.id}`).then((r) => r ?? {}), null);
      if (result === null) return;
      if (result.archived) map().set(item.id, { ...item, archived: true });
      else map().delete(item.id);
      say(done ?? (result.archived ? `Removed “${item.name}”. Past shifts keep it; add it again to bring it back.` : `Removed “${item.name}”.`));
      onChange();
      render();
      first.focus();
    }

    async function add() {
      const name = nameInput.value.trim();
      if (!name) return nameInput.focus();
      const row = await call(() => request('POST', spec.path, { name }));
      if (!row) return undefined;
      map().set(row.id, row);
      nameInput.value = '';
      say(`Added “${row.name}”.`);
      onChange();
      render();
      nameInput.focus();
      return undefined;
    }

    async function addRate() {
      const effective_from = rateDate.value;
      const cents = parseDollars(rateAmount.value);
      if (!effective_from) return say('Choose the date the rate starts.', true);
      if (cents === null) { say('Enter the hourly rate like 11.25.', true); return rateAmount.focus(); }
      const row = await call(() => request('POST', spec.path, { effective_from, rate_cents: cents }));
      if (!row) return undefined;
      map().set(row.id, row);
      rateAmount.value = '';
      say(`Added $${dollars(row.rate_cents)}/hr from ${row.effective_from}.`);
      onChange();
      render();
      rateAmount.focus();
      return undefined;
    }

    addButton.addEventListener('click', isRates ? addRate : add);
    for (const input of isRates ? [rateAmount] : [nameInput]) {
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); (isRates ? addRate : add)(); } });
    }
    render();
    return {
      kind, tab,
      setDate(date) { // only a change of which rate applies needs a redraw
        const before = appliesId();
        shiftDate = date;
        if (appliesId() !== before) this.refresh();
      },
      focus: () => first.focus(),
      // a change from elsewhere: redraw, unless someone is in the middle of editing a row
      refresh: () => { if (document.activeElement?.closest?.('ul.lrows') !== rows) render(); },
    };
  }
}
