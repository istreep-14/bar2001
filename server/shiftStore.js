// Only writer of shifts, shift_breaks, shift_employees, parties, shift_tags and money_entries.
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { invalid, notFound } from './http.js';
import { validateShift, validateMoneyEntry, settleEntryPart, SHIFT_FIELDS } from './validate.js';
import { TIPS_CATEGORY_ID } from './db.js';
import { deriveShift } from './pay.js';

const SHIFT_COLS =
  'id, job_id, location_id, work_date, start_at, end_at, shift_type, notes, external_ref, created_at, updated_at, deleted_at';
const MONEY_COLS = 'id, shift_id, category_id, value_cents, part';
const CHUNK = 500;

const noop = () => {};
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

export function shiftStore(db, { emit = noop } = {}) {
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null;
  const all = (sql, ...args) => db.prepare(sql).all(...args);

  const entryText = (m) =>
    `${one('SELECT name FROM income_categories WHERE id = ?', m.category_id)?.name ?? 'income'} ${dollars(m.value_cents)} (${m.part ?? 'combined'})`;

  const shiftLabel = (shift) => {
    const where = shift.location_id ? one('SELECT name FROM locations WHERE id = ?', shift.location_id)?.name : null;
    return [shift.work_date, where].filter(Boolean).join(' · ');
  };

  // Attach breaks[], employees[], parties[], tags[] and money_entries[] to shift rows, then the derived numbers
  // (paid time and estimated wage), which are worked out from those and the wage history every time.
  function hydrate(rows) {
    const byId = new Map(rows.map((r) => [r.id, { ...r, breaks: [], employees: [], parties: [], tags: [], money_entries: [] }]));
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const marks = slice.map(() => '?').join(',');
      // a break is a time range, or just a length; ranges come first, in time order
      for (const b of all(`SELECT shift_id, start_at, end_at, minutes FROM shift_breaks WHERE shift_id IN (${marks})
                           ORDER BY start_at IS NULL, start_at, rowid`, ...slice)) {
        byId.get(b.shift_id).breaks.push(b.start_at === null ? { minutes: b.minutes } : { start_at: b.start_at, end_at: b.end_at });
      }
      for (const e of all(`SELECT se.shift_id, se.employee_id, se.start_at, se.end_at, se.tips_cents FROM shift_employees se
                           JOIN employees w ON w.id = se.employee_id WHERE se.shift_id IN (${marks}) ORDER BY w.name`, ...slice)) {
        const { shift_id, ...entry } = e;
        byId.get(shift_id).employees.push(entry);
      }
      for (const p of all(`SELECT shift_id, name, guests, start_at, end_at, notes FROM parties WHERE shift_id IN (${marks})
                           ORDER BY start_at IS NULL, start_at, rowid`, ...slice)) {
        const { shift_id, ...party } = p;
        byId.get(shift_id).parties.push(party);
      }
      for (const t of all(`SELECT shift_id, tag FROM shift_tags WHERE shift_id IN (${marks}) ORDER BY tag`, ...slice)) {
        byId.get(t.shift_id).tags.push(t.tag);
      }
      for (const m of all(`SELECT ${MONEY_COLS} FROM money_entries WHERE shift_id IN (${marks}) ORDER BY rowid`, ...slice)) {
        const { shift_id, ...entry } = m;
        byId.get(shift_id).money_entries.push(entry);
      }
    }
    const rates = all('SELECT effective_from, rate_cents FROM wage_rates');
    const roles = new Map(all('SELECT id, role FROM employees').map((e) => [e.id, e.role]));
    return rows.map((r) => {
      const shift = byId.get(r.id);
      return { ...shift, derived: deriveShift(shift, rates, (id) => roles.get(id) ?? null) };
    });
  }

  // The ids a shift points at must exist (the foreign keys would reject them too, but not in plain words).
  function requireCategories(entries) {
    for (const { category_id } of entries ?? []) {
      if (category_id && !one('SELECT 1 AS x FROM income_categories WHERE id = ?', category_id)) throw invalid(['money_entries: no such income type']);
    }
  }

  function requireRefs({ job_id, location_id, employees, money_entries }) {
    requireCategories(money_entries);
    if (job_id && !one('SELECT 1 AS x FROM jobs WHERE id = ?', job_id)) throw invalid(['job_id: no such job']);
    if (location_id && !one('SELECT 1 AS x FROM locations WHERE id = ?', location_id)) throw invalid(['location_id: no such location']);
    for (const { employee_id } of employees ?? []) {
      if (!one('SELECT 1 AS x FROM employees WHERE id = ?', employee_id)) throw invalid([`employees: no such employee ${employee_id}`]);
    }
  }

  const shiftType = (shiftId) => one('SELECT shift_type FROM shifts WHERE id = ?', shiftId)?.shift_type;

  function insertMoney(shiftId, entry) {
    const id = entry.id ?? randomUUID();
    db.prepare(`INSERT INTO money_entries (${MONEY_COLS}) VALUES (?, ?, ?, ?, ?)`).run(
      id, shiftId, entry.category_id ?? TIPS_CATEGORY_ID, entry.value_cents, entry.part ?? null,
    );
    return id;
  }

  function replaceChildren(shiftId, { breaks, employees, parties, tags, money_entries }) {
    if (breaks) {
      db.prepare('DELETE FROM shift_breaks WHERE shift_id = ?').run(shiftId);
      for (const b of breaks) {
        db.prepare('INSERT INTO shift_breaks (id, shift_id, start_at, end_at, minutes) VALUES (?, ?, ?, ?, ?)')
          .run(randomUUID(), shiftId, b.start_at ?? null, b.end_at ?? null, b.minutes ?? null);
      }
    }
    if (employees) {
      db.prepare('DELETE FROM shift_employees WHERE shift_id = ?').run(shiftId);
      for (const e of employees) {
        db.prepare('INSERT INTO shift_employees (shift_id, employee_id, start_at, end_at, tips_cents) VALUES (?, ?, ?, ?, ?)')
          .run(shiftId, e.employee_id, e.start_at ?? null, e.end_at ?? null, e.tips_cents ?? null);
      }
    }
    if (parties) {
      db.prepare('DELETE FROM parties WHERE shift_id = ?').run(shiftId);
      for (const p of parties) {
        db.prepare('INSERT INTO parties (id, shift_id, name, guests, start_at, end_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), shiftId, p.name ?? null, p.guests ?? null, p.start_at ?? null, p.end_at ?? null, p.notes ?? null);
      }
    }
    if (tags) {
      db.prepare('DELETE FROM shift_tags WHERE shift_id = ?').run(shiftId);
      for (const tag of tags) db.prepare('INSERT INTO shift_tags (shift_id, tag) VALUES (?, ?)').run(shiftId, tag);
    }
    if (money_entries) {
      db.prepare('DELETE FROM money_entries WHERE shift_id = ?').run(shiftId);
      for (const entry of money_entries) insertMoney(shiftId, entry);
    }
  }

  const touch = (shiftId) =>
    db.prepare('UPDATE shifts SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), shiftId);

  // The editable document a client sends, rebuilt from a stored shift (used by PATCH).
  const asDocument = (shift) => Object.fromEntries(SHIFT_FIELDS.map((k) => [k, shift[k]]));

  // Tell the live feed about a committed shift change (the full shift rides along).
  const announce = (op, shift, note) =>
    emit({ entity: 'shift', op, id: shift.id, label: shiftLabel(shift), ...(note && { note }), data: shift });

  const store = {
    get(id) {
      const row = one(`SELECT ${SHIFT_COLS} FROM shifts WHERE id = ?`, id);
      return row ? hydrate([row])[0] : null;
    },

    idForExternalRef: (ref) => one('SELECT id FROM shifts WHERE external_ref = ?', ref)?.id ?? null,

    // Newest first. Cursor is the (start_at, id) of the last row of the previous page.
    list({ from, to, job_id, location_id, employee_id, has_party, limit = 50, cursor, includeDeleted = false } = {}) {
      const where = [];
      const args = [];
      if (!includeDeleted) where.push('deleted_at IS NULL');
      if (from) {
        where.push('work_date >= ?');
        args.push(from);
      }
      if (to) {
        where.push('work_date <= ?');
        args.push(to);
      }
      if (job_id) {
        where.push('job_id = ?');
        args.push(job_id);
      }
      if (location_id) {
        where.push('location_id = ?');
        args.push(location_id);
      }
      if (employee_id) {
        where.push('id IN (SELECT shift_id FROM shift_employees WHERE employee_id = ?)');
        args.push(employee_id);
      }
      if (has_party !== undefined) where.push(`${has_party ? '' : 'NOT '}EXISTS (SELECT 1 FROM parties WHERE parties.shift_id = shifts.id)`);
      if (cursor) {
        const [startAt, id] = decodeCursor(cursor);
        where.push('(start_at < ? OR (start_at = ? AND id < ?))');
        args.push(startAt, startAt, id);
      }
      const rows = all(
        `SELECT ${SHIFT_COLS} FROM shifts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY start_at DESC, id DESC LIMIT ?`,
        ...args,
        limit + 1,
      );
      const more = rows.length > limit;
      const page = hydrate(rows.slice(0, limit));
      const last = page[page.length - 1];
      return { shifts: page, next_cursor: more && last ? encodeCursor(last.start_at, last.id) : null };
    },

    // Every shift, deleted included, unpaginated (for /export).
    all: () => hydrate(all(`SELECT ${SHIFT_COLS} FROM shifts ORDER BY start_at, id`)),

    // Idempotent create-or-replace. `input` must already be validated.
    put(id, input, { externalRef = null } = {}) {
      const result = transaction(db, () => {
        requireRefs(input);
        const now = new Date().toISOString();
        const existing = one('SELECT id FROM shifts WHERE id = ?', id);
        const cols = [input.job_id ?? null, input.location_id ?? null, input.work_date, input.start_at, input.end_at, input.shift_type,
          input.notes ?? null];
        if (existing) {
          db.prepare(
            `UPDATE shifts SET job_id = ?, location_id = ?, work_date = ?, start_at = ?, end_at = ?, shift_type = ?, notes = ?,
               updated_at = ?, deleted_at = NULL WHERE id = ?`,
          ).run(...cols, now, id);
        } else {
          db.prepare(
            `INSERT INTO shifts (id, job_id, location_id, work_date, start_at, end_at, shift_type, notes, external_ref, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(id, ...cols, externalRef, now, now);
        }
        replaceChildren(id, {
          breaks: input.breaks ?? [], employees: input.employees ?? [], parties: input.parties ?? [], tags: input.tags ?? [], money_entries: input.money_entries ?? [],
        });
        return { shift: store.get(id), created: !existing };
      });
      announce(result.created ? 'created' : 'updated', result.shift);
      return result;
    },

    // Merge `patch` onto the stored shift and re-validate the whole document.
    patch(id, patch) {
      const shift = transaction(db, () => {
        const current = store.get(id);
        if (!current) throw notFound('shift');
        const { value, problems } = validateShift({ ...asDocument(current), ...patch });
        if (problems.length) throw invalid(problems);
        requireRefs(value);
        db.prepare(
          `UPDATE shifts SET job_id = ?, location_id = ?, work_date = ?, start_at = ?, end_at = ?, shift_type = ?, notes = ?,
             updated_at = ? WHERE id = ?`,
        ).run(value.job_id ?? null, value.location_id ?? null, value.work_date, value.start_at, value.end_at, value.shift_type,
          value.notes ?? null, new Date().toISOString(), id);
        replaceChildren(id, {
          breaks: 'breaks' in patch ? value.breaks : null,
          employees: 'employees' in patch ? value.employees : null,
          parties: 'parties' in patch ? value.parties : null,
          tags: 'tags' in patch ? value.tags : null,
          // tips are rewritten when the type changes too, since each entry's `part` follows the type
          money_entries: 'money_entries' in patch || 'shift_type' in patch ? value.money_entries : null,
        });
        return store.get(id);
      });
      announce('updated', shift);
      return shift;
    },

    // Soft delete by default; hard delete cascades to tags and money entries.
    remove(id, { hard = false } = {}) {
      const before = transaction(db, () => {
        const shift = store.get(id);
        if (!shift) throw notFound('shift');
        if (hard) db.prepare('DELETE FROM shifts WHERE id = ?').run(id);
        else {
          const now = new Date().toISOString();
          db.prepare('UPDATE shifts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, id);
        }
        return shift;
      });
      if (hard) emit({ entity: 'shift', op: 'purged', id, label: shiftLabel(before) });
      else if (!before.deleted_at) announce('deleted', store.get(id));
    },

    // money entries
    getMoney: (id) => one(`SELECT ${MONEY_COLS} FROM money_entries WHERE id = ?`, id),
    addMoney(shiftId, entry) {
      const added = transaction(db, () => {
        if (!one('SELECT 1 AS x FROM shifts WHERE id = ?', shiftId)) throw notFound('shift');
        const problem = settleEntryPart(entry, shiftType(shiftId));
        if (problem) throw invalid([problem]);
        requireCategories([entry]);
        const id = insertMoney(shiftId, entry);
        touch(shiftId);
        return store.getMoney(id);
      });
      announce('updated', store.get(shiftId), `money added: ${entryText(added)}`);
      return added;
    },
    patchMoney(id, patch) {
      const changed = transaction(db, () => {
        const current = store.getMoney(id);
        if (!current) throw notFound('money entry');
        const { shift_id, id: _id, ...fields } = current;
        const { value, problems } = validateMoneyEntry({ ...fields, ...patch });
        if (problems.length) throw invalid(problems);
        const problem = settleEntryPart(value, shiftType(shift_id));
        if (problem) throw invalid([problem]);
        requireCategories([value]);
        db.prepare('UPDATE money_entries SET category_id = ?, value_cents = ?, part = ? WHERE id = ?')
          .run(value.category_id, value.value_cents, value.part ?? null, id);
        touch(shift_id);
        return store.getMoney(id);
      });
      announce('updated', store.get(changed.shift_id), `money changed: ${entryText(changed)}`);
      return changed;
    },
    removeMoney(id) {
      const removed = transaction(db, () => {
        const current = store.getMoney(id);
        if (!current) throw notFound('money entry');
        db.prepare('DELETE FROM money_entries WHERE id = ?').run(id);
        touch(current.shift_id);
        return current;
      });
      announce('updated', store.get(removed.shift_id), `money removed: ${entryText(removed)}`);
    },
  };
  return store;
}

const encodeCursor = (startAt, id) => Buffer.from(`${startAt}|${id}`).toString('base64url');
function decodeCursor(cursor) {
  const [startAt, id] = Buffer.from(String(cursor), 'base64url').toString().split('|');
  if (!startAt || !id) throw invalid(['cursor: invalid']);
  return [startAt, id];
}
