// The left panel of the shifts view: tabbed navigation for browsing. Browse (Overview, Calendar, Shifts, Live feed) and Lists
// (Locations, Misc types, Wage rates), with the selected page in the panel to its right. Entering or editing a shift is not
// a page here: it opens as a dialog over this view (dashboard/stepper.js), so the two levels never mix.
// Switching page fires a `sidepaint` event on the document, so pages that draw only while shown (Overview, Calendar) catch up.
const TABS = ['overview', 'calendar', 'shifts', 'feed', 'listLocations', 'listTypes', 'listRates'];

export function createSidePanel() {
  const root = document.getElementById('sidePanel');
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const paneOf = (name) => document.getElementById('pane' + name[0].toUpperCase() + name.slice(1));
  let current = 'overview';

  function paint() {
    for (const tab of tabs) {
      const name = tab.dataset.tab;
      const on = name === current;
      tab.hidden = false;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      paneOf(name).hidden = !on;
    }
    document.dispatchEvent(new CustomEvent('sidepaint'));
  }

  const api = {
    current: () => current,
    has: (name) => TABS.includes(name),
    show(name) {
      if (!TABS.includes(name)) return;
      current = name;
      paint();
    },
  };

  for (const tab of tabs) tab.addEventListener('click', () => api.show(tab.dataset.tab));
  root.addEventListener('keydown', (ev) => {
    const back = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft';
    if (!back && ev.key !== 'ArrowDown' && ev.key !== 'ArrowRight') return;
    const at = tabs.indexOf(document.activeElement);
    if (at < 0) return;
    ev.preventDefault();
    const next = tabs[(at + (back ? tabs.length - 1 : 1)) % tabs.length];
    api.show(next.dataset.tab);
    next.focus();
  });
  paint();
  return api;
}
