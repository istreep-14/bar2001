// The left panel of the shifts view: tabbed navigation in section groups, with the selected page's input in the panel
// to its right. Browsing has Browse (Shifts, Live feed) and Lists (Locations, Misc types, Wage rates). Editing a shift
// has a group per part of it, and a page per thing in the group:
//   Info     Date, Time, Type
//   Income   Tips, Wage, Misc
//   Details  Location, Crew, Party, Notes
// The lists are not a group of their own while editing: each one is on the page it feeds (locations on Location, misc
// types on Misc, wage rates on Wage), so what a shift points at is edited where it is used, without leaving the form.
// The long form is never one scroll and nothing pops up; every page is one click away, or a Back / Next away, and the
// form's state is kept while another page is open. Each editing tab carries a live one-line summary and a dot when a
// field on it has a problem.
//
// Only the tabs of the current mode are shown (and a group with none is hidden); switching mode keeps the current tab
// when the new mode has it, or shows `show` / the first tab. Elements marked data-only="edit" (the form, its Close
// link, Save and Cancel) are shown only while editing.
const LISTS = ['listLocations', 'listTypes', 'listRates'];
const STEPS = ['date', 'time', 'type', 'tips', 'wage', 'misc', 'location', 'crew', 'party', 'notes']; // the order Back / Next walk
const MODES = {
  browse: ['shifts', 'feed', ...LISTS],
  edit: STEPS,
};

export function createSidePanel() {
  const root = document.getElementById('sidePanel');
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const groups = [...root.querySelectorAll('.navgroup')];
  const byName = new Map(tabs.map((t) => [t.dataset.tab, t]));
  const paneOf = (name) => document.getElementById('pane' + name[0].toUpperCase() + name.slice(1));
  let mode = 'browse';
  let current = 'shifts';

  function paint() {
    document.body.dataset.mode = mode;
    for (const el of document.querySelectorAll('[data-only]')) el.hidden = el.dataset.only !== mode;
    for (const tab of tabs) {
      const name = tab.dataset.tab;
      const on = name === current;
      tab.hidden = !MODES[mode].includes(name);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      paneOf(name).hidden = !on;
    }
    for (const group of groups) group.hidden = [...group.querySelectorAll('[role="tab"]')].every((t) => t.hidden);
    // the first page has no Back and the last no Next
    STEPS.forEach((name, i) => {
      const pane = paneOf(name);
      pane.querySelector('[data-step="-1"]').hidden = i === 0;
      pane.querySelector('[data-step="1"]').hidden = i === STEPS.length - 1;
    });
  }

  const api = {
    // `title` heads the panel; `show` names the tab to land on.
    setMode(next, { title = next === 'edit' ? 'Edit shift' : 'Shifts', show } = {}) {
      mode = next;
      document.getElementById('navTitle').textContent = title;
      if (show && MODES[mode].includes(show)) current = show;
      else if (!MODES[mode].includes(current)) current = MODES[mode][0];
      paint();
    },
    // Is this tab part of the current mode?
    has: (name) => MODES[mode].includes(name),
    show(name) {
      if (!MODES[mode].includes(name)) return;
      current = name;
      paint();
    },
    // Back (-1) and Next (1) through the pages of the shift, landing on the page's first field.
    step(by) {
      const at = STEPS.indexOf(current);
      const next = STEPS[at + by];
      if (at < 0 || !next) return;
      api.show(next);
      paneOf(next).querySelector('input:not([type="radio"]), textarea, select, .pill, .seg input, button:not([data-step])')?.focus();
    },
    // Show the tab that holds `el` (a field with a problem, say).
    reveal(el) {
      const name = el?.closest?.('[role="tabpanel"]')?.dataset.tab;
      if (name) api.show(name);
    },
    // The live line under a tab's name.
    summarize(name, text) {
      const line = byName.get(name)?.querySelector('.tabsum');
      if (line && line.textContent !== text) line.textContent = text;
    },
    // Put a problem dot on exactly these tabs.
    flag(names) {
      for (const [name, tab] of byName) tab.toggleAttribute('data-flag', names.has(name));
    },
  };

  for (const tab of tabs) tab.addEventListener('click', () => api.show(tab.dataset.tab));
  document.addEventListener('click', (ev) => {
    const button = ev.target.closest?.('#shiftForm [data-step]');
    if (button) api.step(Number(button.dataset.step));
  });
  root.addEventListener('keydown', (ev) => {
    const back = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft';
    if (!back && ev.key !== 'ArrowDown' && ev.key !== 'ArrowRight') return;
    const shown = tabs.filter((t) => !t.hidden);
    const at = shown.indexOf(document.activeElement);
    if (at < 0) return;
    ev.preventDefault();
    const next = shown[(at + (back ? shown.length - 1 : 1)) % shown.length];
    api.show(next.dataset.tab);
    next.focus();
  });
  paint();
  return api;
}
