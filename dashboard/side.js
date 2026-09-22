// The app's two-tier rail: a narrow icon strip (#groupNav) that picks a GROUP - Shift, Employees, Lists -
// and a wider strip (#nav) that lists the pages inside whichever group is active. A page belongs to exactly
// one group; Employees has none - it's a single master-detail page, so the rail has no second tier while
// it's active (`.shell.solo`). Switching page fires a `sidepaint` event, so pages that draw only while shown
// (Overview, Calendar) catch up; switching group calls `onGroup` so the caller can show or hide whatever
// isn't part of this rail at all (the Employees workspace, the "+ New shift" button).
const GROUPS = [
  { id: 'shift', label: 'Shift' },
  { id: 'employees', label: 'Employees', solo: true },
  { id: 'lists', label: 'Lists' },
];
const PAGES = [
  { id: 'overview', label: 'Overview', group: 'shift', section: 'Shift' },
  { id: 'calendar', label: 'Calendar', group: 'shift', section: 'Shift' },
  { id: 'shifts', label: 'Log', group: 'shift', section: 'Shift' },
  { id: 'feed', label: 'Live feed', group: 'shift', section: 'Shift' },
  { id: 'listLocations', label: 'Locations', group: 'lists', section: 'Lists' },
  { id: 'listTypes', label: 'Misc types', group: 'lists', section: 'Lists' },
  { id: 'listRates', label: 'Wage rates', group: 'lists', section: 'Lists' },
];

export function createSidePanel({ onGroup } = {}) {
  const shell = document.querySelector('.shell');
  const gtiles = [...document.querySelectorAll('#groupNav .gtile')];
  const nav = document.getElementById('nav');
  const paneOf = (id) => document.getElementById('pane' + id[0].toUpperCase() + id.slice(1));
  const lastPage = {};   // a tile takes you back to the page you left in its group
  let group = 'shift';
  let current = 'overview';

  function paintPages() {
    for (const p of PAGES) paneOf(p.id).hidden = !(p.group === group && p.id === current);
    document.dispatchEvent(new CustomEvent('sidepaint'));
  }
  function paintNav() {
    for (const t of gtiles) t.setAttribute('aria-current', String(t.dataset.group === group));
    shell.classList.toggle('solo', !!GROUPS.find((g) => g.id === group)?.solo);
    const sections = [];
    for (const p of PAGES.filter((p) => p.group === group)) {
      let sec = sections.find((s) => s.name === p.section);
      if (!sec) sections.push((sec = { name: p.section, pages: [] }));
      sec.pages.push(p);
    }
    nav.replaceChildren(...sections.map((sec) => {
      const box = document.createElement('div');
      box.className = 'navsec';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', sec.name);
      const h3 = document.createElement('h3');
      h3.className = 'rail2-title';
      h3.textContent = sec.name;
      const buttons = sec.pages.map((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = p.label;
        btn.setAttribute('aria-current', String(p.id === current));
        btn.addEventListener('click', () => api.show(p.id));
        return btn;
      });
      box.append(h3, ...buttons);
      return box;
    }));
  }

  const api = {
    current: () => current,
    group: () => group,
    has: (id) => PAGES.some((p) => p.id === id),
    show(id) {
      const p = PAGES.find((x) => x.id === id);
      if (!p) return;
      const groupChanged = p.group !== group;
      group = p.group;
      current = id;
      lastPage[group] = id;
      paintNav();
      paintPages();
      if (groupChanged) onGroup?.(group);
    },
    showGroup(id) {
      if (id === group || !GROUPS.some((g) => g.id === id)) return;
      group = id;
      current = lastPage[id] || PAGES.find((p) => p.group === id)?.id || current;
      paintNav();
      paintPages();
      onGroup?.(group);
    },
  };
  for (const t of gtiles) t.addEventListener('click', () => api.showGroup(t.dataset.group));
  paintNav();
  paintPages();
  return api;
}
