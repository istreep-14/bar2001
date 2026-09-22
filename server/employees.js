// Only writer of the employees and employee_roles tables: the people you work with. A real table, not a
// pick list, because it keeps gaining columns (today: name, first/last, id_number, roles, manager, is_me,
// notes). A name is unique ignoring case, adding a name that exists returns that person (un-archived if
// need be), and a person who appears on a shift is archived instead of deleted, so history keeps resolving.
// `is_me` flags your own row among them; the partial unique index on it means only one can ever be set, so
// every write that could set it true is checked here first and turned into a plain-words 409.
import { randomUUID } from 'node:crypto';
import { conflict, notFound } from './http.js';
import { wallMinutes } from './time.js';

const noop = () => {};
const shape = (row) => (row ? { ...row, archived: !!row.archived, manager: !!row.manager, is_me: !!row.is_me } : null);

export function employeeStore(db, { emit = noop } = {}) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const announce = (op, row) => {
    emit({ entity: 'employee', op, id: row.id, label: row.name, data: row });
    return row;
  };

  // Attach roles[] (from employee_roles, alphabetical) to each shaped employee row.
  function hydrateRoles(rows) {
    const byId = new Map(rows.map((r) => [r.id, { ...r, roles: [] }]));
    const ids = [...byId.keys()];
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      for (const r of all(`SELECT employee_id, role FROM employee_roles WHERE employee_id IN (${marks}) ORDER BY role`, ...ids)) {
        byId.get(r.employee_id).roles.push(r.role);
      }
    }
    return rows.map((r) => byId.get(r.id));
  }

  function replaceRoles(employeeId, roles) {
    db.prepare('DELETE FROM employee_roles WHERE employee_id = ?').run(employeeId);
    for (const role of roles) db.prepare('INSERT INTO employee_roles (employee_id, role) VALUES (?, ?)').run(employeeId, role);
  }

  // Only meaningful when `isMe` is true: is it already someone else's?
  function requireSoleMe(isMe, excludeId = null) {
    if (!isMe) return;
    const clash = excludeId
      ? one('SELECT 1 AS x FROM employees WHERE is_me = 1 AND id != ?', excludeId)
      : one('SELECT 1 AS x FROM employees WHERE is_me = 1');
    if (clash) throw conflict(['is_me: already set on another employee']);
  }

  const store = {
    list({ includeArchived = false } = {}) {
      const rows = all(`SELECT * FROM employees ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name`).map(shape);
      return hydrateRoles(rows);
    },
    get(id) {
      const row = shape(one('SELECT * FROM employees WHERE id = ?', id));
      return row ? hydrateRoles([row])[0] : null;
    },

    // What each person has done on the shifts you logged, worked out from the shift_employees rows on every read and
    // never stored. Only people with at least one (not deleted) shift appear. A person's hours are their own start to
    // end, so a shift with no times adds a shift but no minutes (`timed_shifts` says how many had times), and the
    // same goes for tips (`tipped_shifts`).
    summary() {
      const rows = db.prepare(`SELECT se.employee_id, s.work_date, se.start_at, se.end_at, se.tips_cents
                               FROM shift_employees se JOIN shifts s ON s.id = se.shift_id
                               WHERE s.deleted_at IS NULL`).all();
      const byId = new Map();
      for (const r of rows) {
        const t = byId.get(r.employee_id) ?? {
          employee_id: r.employee_id, shifts: 0, timed_shifts: 0, minutes: 0, tipped_shifts: 0, tips_cents: 0,
          first_worked: null, last_worked: null,
        };
        t.shifts += 1;
        if (r.start_at) {
          t.timed_shifts += 1;
          t.minutes += wallMinutes(r.start_at, r.end_at);
        }
        if (r.tips_cents != null) {
          t.tipped_shifts += 1;
          t.tips_cents += r.tips_cents;
        }
        if (r.work_date) {
          if (t.first_worked === null || r.work_date < t.first_worked) t.first_worked = r.work_date;
          if (t.last_worked === null || r.work_date > t.last_worked) t.last_worked = r.work_date;
        }
        byId.set(r.employee_id, t);
      }
      return [...byId.values()];
    },

    // Find-or-create by name, so "add" is safe to repeat. Returns { row, created }. Only the name decides a match;
    // the other fields are used when the person is new and otherwise left as they are.
    ensure({ name, first = null, last = null, id_number = null, roles = [], manager = false, is_me = false, notes = null }) {
      const found = shape(one('SELECT * FROM employees WHERE name = ?', name));
      if (found) {
        if (!found.archived) return { row: store.get(found.id), created: false };
        db.prepare('UPDATE employees SET archived = 0 WHERE id = ?').run(found.id);
        return { row: announce('updated', store.get(found.id)), created: false };
      }
      requireSoleMe(is_me);
      const id = randomUUID();
      db.prepare(
        'INSERT INTO employees (id, name, first, last, id_number, manager, is_me, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, name, first, last, id_number, Number(manager), Number(is_me), notes);
      replaceRoles(id, roles);
      return { row: announce('created', store.get(id)), created: true };
    },

    update(id, patch) {
      if (!store.get(id)) throw notFound('employee');
      if (patch.name !== undefined && one('SELECT 1 AS x FROM employees WHERE name = ? AND id != ?', patch.name, id)) {
        throw conflict([`name: "${patch.name}" is already on your employees list`]);
      }
      if (patch.is_me !== undefined) requireSoleMe(patch.is_me, id);
      const { roles, ...rest } = patch;
      const keys = Object.keys(rest);
      if (keys.length) {
        const bound = Object.fromEntries(keys.map((k) => [k, typeof rest[k] === 'boolean' ? Number(rest[k]) : rest[k] ?? null]));
        db.prepare(`UPDATE employees SET ${keys.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({ ...bound, id });
      }
      if (roles !== undefined) replaceRoles(id, roles);
      return announce('updated', store.get(id));
    },

    remove(id) {
      const row = store.get(id);
      if (!row) throw notFound('employee');
      if (one('SELECT 1 AS x FROM shift_employees WHERE employee_id = ?', id)) {
        db.prepare('UPDATE employees SET archived = 1 WHERE id = ?').run(id);
        announce('archived', store.get(id));
        return { archived: true };
      }
      db.prepare('DELETE FROM employees WHERE id = ?').run(id); // employee_roles cascades
      emit({ entity: 'employee', op: 'deleted', id, label: row.name });
      return { archived: false };
    },
  };
  return store;
}
