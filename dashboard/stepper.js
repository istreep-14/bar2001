// The shift entry dialog. Adding or editing a shift opens over the shifts view as a modal, so the levels read as a
// hierarchy in its header: Shifts › New shift › Time. Inside it, tabbed pages in section groups down the left (Info: Date,
// Time, Type; Income: Tips, Wage, Misc; Details: Location, Crew, Party, Notes) with the selected page's input to the right,
// and Back / Next / Save in the footer. Each tab carries a live one-line summary and a dot when a field on it has a
// problem; every page stays built while another is open, so nothing typed is lost by moving around.
// A native <dialog> gives the focus trap, Esc and the backdrop. Esc and the Close button ask the form (onCancel) rather than
// closing outright, so it can confirm before throwing away typed changes.
// Switching page fires a `steppaint` event on the document, so the form can draw that page's figures.
const STEPS = ['date', 'time', 'type', 'tips', 'wage', 'misc', 'location', 'crew', 'party', 'notes']; // the order Back / Next walk

export function createStepper() {
  const dialog = document.getElementById('shiftDialog');
  const nav = document.getElementById('stepper');
  const tabs = [...nav.querySelectorAll('[role="tab"]')];
  const groups = [...nav.querySelectorAll('.navgroup')];
  const byName = new Map(tabs.map((t) => [t.dataset.tab, t]));
  const paneOf = (name) => document.getElementById('pane' + name[0].toUpperCase() + name.slice(1));
  let current = 'date';
  let cancelHandler = null;

  function paint() {
    for (const tab of tabs) {
      const name = tab.dataset.tab;
      const on = name === current;
      tab.hidden = false;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      paneOf(name).hidden = !on;
    }
    for (const group of groups) group.hidden = false;
    // the first page has no Back and the last no Next
    const at = STEPS.indexOf(current);
    dialog.querySelector('[data-step="-1"]').disabled = at === 0;
    dialog.querySelector('[data-step="1"]').disabled = at === STEPS.length - 1;
    document.getElementById('dlgPage').textContent = byName.get(current).querySelector('.tabname').textContent;
    document.dispatchEvent(new CustomEvent('steppaint'));
  }

  const api = {
    isOpen: () => dialog.open,
    current: () => current,
    // Open the dialog on `show` (a page name), headed `title`.
    open({ title, show = 'date' }) {
      document.getElementById('dlgTitle').textContent = title;
      current = show;
      if (!dialog.open) dialog.showModal();
      dialog.querySelector('.steppanes').scrollTop = 0;
      paint();
    },
    close() { if (dialog.open) dialog.close(); },
    onCancel(fn) { cancelHandler = fn; },
    setMeta(text) { document.getElementById('dlgMeta').textContent = text; },
    show(name) {
      if (!STEPS.includes(name)) return;
      current = name;
      paint();
      dialog.querySelector('.steppanes').scrollTop = 0;
    },
    // Back (-1) and Next (1) through the pages of the shift, landing on the page's first field.
    step(by) {
      const next = STEPS[STEPS.indexOf(current) + by];
      if (!next) return;
      api.show(next);
      paneOf(next).querySelector('input:not([type="radio"]), textarea, select, .pill, .seg input, .day.sel, button:not([data-step])')?.focus();
    },
    // Show the page that holds `el` (a field with a problem, say).
    reveal(el) {
      const name = el?.closest?.('[role="tabpanel"][data-tab]')?.dataset.tab; // the page, not a break's or a party's own tab panel inside it
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
  dialog.addEventListener('click', (ev) => {
    const button = ev.target.closest?.('[data-step]');
    if (button) api.step(Number(button.dataset.step));
  });
  dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); cancelHandler?.(); }); // Esc
  nav.addEventListener('keydown', (ev) => {
    const back = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft';
    if (!back && ev.key !== 'ArrowDown' && ev.key !== 'ArrowRight') return;
    const at = tabs.indexOf(document.activeElement);
    if (at < 0) return;
    ev.preventDefault();
    const next = tabs[(at + (back ? tabs.length - 1 : 1)) % tabs.length];
    api.show(next.dataset.tab);
    next.focus();
  });
  return api;
}
