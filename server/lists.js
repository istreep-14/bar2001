// Only writer of the pick lists behind the shift form: locations and income types. (Employees are a real table
// with their own store, employees.js.)
// Each is just a unique name (ignoring case) that a shift can point at. An entry that a shift
// refers to is archived instead of deleted, so history keeps resolving; typing an archived name
// back in brings the same entry back.
import { randomUUID } from 'node:crypto';
import { conflict, notFound } from './http.js';
export { TIPS_CATEGORY_ID } from './db.js';

// `system` only exists on income types: the built-in Tips row, which can't be renamed, archived or removed.
const boolify = (row) => (row ? { ...row, archived: !!row.archived, ...('system' in row && { system: !!row.system }) } : null);
const builtIn = (row) => conflict([`“${row.name}” is built in and can’t be changed`]);
const noop = () => {};

// `table` and `usedBy` are fixed strings from this file, never user input.
function createList(db, { table, entity, usedBy, emit }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const announce = (op, row) => {
    emit({ entity, op, id: row.id, label: row.name, data: row });
    return row;
  };
  const clash = (name, exceptId) => one(`SELECT id FROM ${table} WHERE name = ? AND id != ?`, name, exceptId ?? '');

  const list = {
    list({ includeArchived = false } = {}) {
      return db.prepare(`SELECT * FROM ${table} ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name`).all().map(boolify);
    },
    get: (id) => boolify(one(`SELECT * FROM ${table} WHERE id = ?`, id)),

    // Find-or-create by name, which makes "add" safe to repeat. Returns { row, created }.
    ensure(name) {
      const found = boolify(one(`SELECT * FROM ${table} WHERE name = ?`, name));
      if (found) {
        if (!found.archived) return { row: found, created: false };
        db.prepare(`UPDATE ${table} SET archived = 0 WHERE id = ?`).run(found.id);
        return { row: announce('updated', list.get(found.id)), created: false };
      }
      const id = randomUUID();
      db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`).run(id, name);
      return { row: announce('created', list.get(id)), created: true };
    },

    update(id, patch) {
      const row = list.get(id);
      if (!row) throw notFound(entity);
      if (row.system) throw builtIn(row);
      if (patch.name !== undefined && clash(patch.name, id)) throw conflict([`name: "${patch.name}" is already in the list`]);
      const sets = Object.keys(patch).map((k) => `${k} = $${k}`);
      if (sets.length) {
        const bound = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'boolean' ? Number(v) : v]));
        db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $id`).run({ ...bound, id });
      }
      return announce('updated', list.get(id));
    },

    remove(id) {
      const row = list.get(id);
      if (!row) throw notFound(entity);
      if (row.system) throw builtIn(row);
      if (one(usedBy, id)) {
        db.prepare(`UPDATE ${table} SET archived = 1 WHERE id = ?`).run(id);
        announce('archived', list.get(id));
        return { archived: true };
      }
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      emit({ entity, op: 'deleted', id, label: row.name });
      return { archived: false };
    },
  };
  return list;
}

export function listStore(db, { emit = noop } = {}) {
  return {
    locations: createList(db, {
      table: 'locations',
      entity: 'location',
      usedBy: 'SELECT 1 AS x FROM shifts WHERE location_id = ?',
      emit,
    }),
    incomeCategories: createList(db, {
      table: 'income_categories',
      entity: 'income_category',
      usedBy: 'SELECT 1 AS x FROM money_entries WHERE category_id = ?',
      emit,
    }),
  };
}
