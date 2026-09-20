// A tab strip inside a page, for a group of things that can be many: breaks, parties, the people on a shift. One editor is
// open at a time and the strip says what each holds, instead of a growing pile of rows. Every editor stays built (only
// the open one is shown), so what was typed in the others is kept. Roving focus: Left / Right / Home / End move between
// tabs, and the "+ Add" tab at the end makes a new one.
//
//   const tabs = createTabs({ h, label: 'Breaks', addLabel: '+ Add break', empty: 'No breaks.', onAdd })
//   tabs.setItems([{ id, label: 'Break 1', sub: '30 min', panel: <element> }], { select: id })
import { h } from '/viz.js';

let serial = 0;

export function createTabs({ label, addLabel, empty = '', onAdd, onSelect }) {
  const uid = ++serial;
  let items = [];
  let active = null;
  const buttons = new Map();
  const list = h('div', { class: 'stabs', role: 'tablist', 'aria-label': label });
  const add = h('button', { type: 'button', class: 'stab add' }, addLabel);
  const emptyEl = h('p', { class: 'muted stab-empty' }, empty);
  const panels = h('div', { class: 'stab-panels' });
  const el = h('div', { class: 'subtabs' }, list, emptyEl, panels);
  const idOf = (item, kind) => `st${uid}-${kind}-${item.id}`;

  function paint() {
    buttons.clear();
    list.replaceChildren(...items.map((item) => {
      const on = item.id === active;
      const btn = h('button', { type: 'button', role: 'tab', class: 'stab', id: idOf(item, 'tab'), 'aria-controls': idOf(item, 'panel'), 'aria-selected': String(on), tabindex: on ? '0' : '-1' },
        h('span', { class: 'sl' }, item.label), h('span', { class: 'ss' }, item.sub || ''));
      btn.addEventListener('click', () => api.select(item.id, { focus: true }));
      buttons.set(item.id, btn);
      return btn;
    }), add);
    for (const item of items) {
      item.panel.setAttribute('role', 'tabpanel');
      item.panel.id = idOf(item, 'panel');
      item.panel.setAttribute('aria-labelledby', idOf(item, 'tab'));
      item.panel.hidden = item.id !== active;
    }
    panels.replaceChildren(...items.map((i) => i.panel));
    emptyEl.hidden = items.length > 0;
    add.textContent = addLabel;
    api.flag();
  }

  const api = {
    el,
    // `select` picks the open tab (a new one, say); otherwise the open one stays if it is still there.
    setItems(next, { select } = {}) {
      items = next;
      active = select && next.some((i) => i.id === select) ? select : next.some((i) => i.id === active) ? active : next[0]?.id ?? null;
      paint();
    },
    active: () => active,
    select(id, { focus = false } = {}) {
      if (!items.some((i) => i.id === id)) return;
      active = id;
      paint();
      onSelect?.(id);
      if (focus) buttons.get(id)?.focus();
    },
    // The little line under a tab's name ("30 min"), kept live without redrawing the strip.
    setSub(id, text) {
      const sub = buttons.get(id)?.querySelector('.ss');
      if (sub && sub.textContent !== text) sub.textContent = text;
    },
    setLabel(id, text) {
      const name = buttons.get(id)?.querySelector('.sl');
      if (name && name.textContent !== text) name.textContent = text;
    },
    // Open the tab that holds `node` (a field with a problem, say). True if it was one of ours.
    reveal(node) {
      const item = items.find((i) => i.panel.contains(node));
      if (!item) return false;
      if (item.id !== active) api.select(item.id);
      return true;
    },
    // A dot on every tab whose editor holds a field with a problem.
    flag() {
      for (const item of items) buttons.get(item.id)?.toggleAttribute('data-flag', !!item.panel.querySelector('[aria-invalid]'));
    },
    focusAdd: () => add.focus(),
  };

  add.addEventListener('click', () => onAdd?.());
  list.addEventListener('keydown', (ev) => {
    const at = items.findIndex((i) => buttons.get(i.id) === document.activeElement);
    if (at < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? items.length - 1 : (at + (ev.key === 'ArrowLeft' ? items.length - 1 : 1)) % items.length;
    api.select(items[next].id, { focus: true });
  });
  paint();
  return api;
}
