// Only writer of venues, jobs and wage_rates. (Venues and jobs are no longer used by the shift form; wage
// rates are one global hourly-wage history.)
import { randomUUID } from 'node:crypto';
import { transaction, nulls } from './db.js';
import { conflict, invalid, notFound } from './http.js';

const boolify = (row) => (row ? { ...row, archived: !!row.archived } : null);
const dbValue = (v) => (typeof v === 'boolean' ? Number(v) : v);

function updateRow(db, table, id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = $${k}`).join(', ');
  const bound = Object.fromEntries(keys.map((k) => [k, dbValue(fields[k])]));
  db.prepare(`UPDATE ${table} SET ${sets} WHERE id = $id`).run(nulls({ ...bound, id }));
}

const noop = () => {};

export function catalogStore(db, { emit = noop } = {}) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);

  // Emit a change event for `row` and hand the row back to the caller.
  const announce = (entity, op, row, label) => {
    emit({ entity, op, id: row.id, label: label(row), data: row });
    return row;
  };

  // One rate per start date; say so in plain words instead of a raw constraint error.
  const requireFreeDate = (date, exceptId = '') => {
    if (one('SELECT 1 AS x FROM wage_rates WHERE effective_from = ? AND id != ?', date, exceptId)) {
      throw conflict([`effective_from: there is already a rate from ${date}; change that one instead`]);
    }
  };

  const store = {
    // venues
    listVenues({ includeArchived = false } = {}) {
      return all(`SELECT * FROM venues ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name`).map(boolify);
    },
    getVenue: (id) => boolify(one('SELECT * FROM venues WHERE id = ?', id)),
    createVenue({ name, notes = null, archived = false }) {
      const id = randomUUID();
      db.prepare('INSERT INTO venues (id, name, notes, archived) VALUES (?, ?, ?, ?)').run(id, name, notes, Number(archived));
      return announce('venue', 'created', store.getVenue(id), (v) => v.name);
    },
    updateVenue(id, patch) {
      if (!store.getVenue(id)) throw notFound('venue');
      updateRow(db, 'venues', id, patch);
      return announce('venue', 'updated', store.getVenue(id), (v) => v.name);
    },
    // Referenced venues are archived instead of deleted so history keeps resolving.
    deleteVenue(id) {
      const venue = store.getVenue(id);
      if (!venue) throw notFound('venue');
      if (one('SELECT 1 AS x FROM jobs WHERE venue_id = ?', id)) {
        updateRow(db, 'venues', id, { archived: 1 });
        announce('venue', 'archived', store.getVenue(id), (v) => v.name);
        return { archived: true };
      }
      db.prepare('DELETE FROM venues WHERE id = ?').run(id);
      emit({ entity: 'venue', op: 'deleted', id, label: venue.name });
      return { archived: false };
    },

    // jobs
    listJobs({ venue_id, includeArchived = false } = {}) {
      const where = [];
      const args = [];
      if (!includeArchived) where.push('archived = 0');
      if (venue_id) {
        where.push('venue_id = ?');
        args.push(venue_id);
      }
      return all(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY title`, ...args).map(boolify);
    },
    getJob: (id) => boolify(one('SELECT * FROM jobs WHERE id = ?', id)),
    createJob({ venue_id, title, archived = false }) {
      requireRef(store.getVenue(venue_id), 'venue_id', 'venue');
      const id = randomUUID();
      db.prepare('INSERT INTO jobs (id, venue_id, title, archived) VALUES (?, ?, ?, ?)').run(id, venue_id, title, Number(archived));
      return announce('job', 'created', store.getJob(id), (j) => j.title);
    },
    updateJob(id, patch) {
      if (!store.getJob(id)) throw notFound('job');
      if (patch.venue_id) requireRef(store.getVenue(patch.venue_id), 'venue_id', 'venue');
      updateRow(db, 'jobs', id, patch);
      return announce('job', 'updated', store.getJob(id), (j) => j.title);
    },
    deleteJob(id) {
      const job = store.getJob(id);
      if (!job) throw notFound('job');
      if (one('SELECT 1 AS x FROM shifts WHERE job_id = ?', id)) {
        updateRow(db, 'jobs', id, { archived: 1 });
        announce('job', 'archived', store.getJob(id), (j) => j.title);
        return { archived: true };
      }
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      emit({ entity: 'job', op: 'deleted', id, label: job.title });
      return { archived: false };
    },

    // wage rates
    listWageRates: () => all('SELECT * FROM wage_rates ORDER BY effective_from'),
    getWageRate: (id) => one('SELECT * FROM wage_rates WHERE id = ?', id) ?? null,
    createWageRate({ effective_from, rate_cents, note = null }) {
      requireFreeDate(effective_from);
      const id = randomUUID();
      db.prepare('INSERT INTO wage_rates (id, effective_from, rate_cents, note) VALUES (?, ?, ?, ?)').run(id, effective_from, rate_cents, note);
      return announce('wage_rate', 'created', store.getWageRate(id), rateLabel);
    },
    updateWageRate(id, patch) {
      if (!store.getWageRate(id)) throw notFound('wage rate');
      if (patch.effective_from) requireFreeDate(patch.effective_from, id);
      updateRow(db, 'wage_rates', id, patch);
      return announce('wage_rate', 'updated', store.getWageRate(id), rateLabel);
    },
    deleteWageRate(id) {
      const rate = store.getWageRate(id);
      if (!rate) throw notFound('wage rate');
      db.prepare('DELETE FROM wage_rates WHERE id = ?').run(id);
      emit({ entity: 'wage_rate', op: 'deleted', id, label: rateLabel(rate) });
    },

    // Used by the importer: find-or-create so re-running adds nothing.
    ensureVenue(name) {
      const found = one('SELECT * FROM venues WHERE name = ?', name);
      return found ? boolify(found) : store.createVenue({ name });
    },
    ensureJob(venue_id, title) {
      const found = one('SELECT * FROM jobs WHERE venue_id = ? AND title = ?', venue_id, title);
      return found ? boolify(found) : store.createJob({ venue_id, title });
    },
    ensureWageRate({ effective_from, rate_cents, note = null }) {
      const found = one('SELECT * FROM wage_rates WHERE effective_from = ?', effective_from);
      return found ?? store.createWageRate({ effective_from, rate_cents, note });
    },

    tx: (fn) => transaction(db, fn),
  };
  return store;
}

const rateLabel = (r) => `${r.effective_from} · $${(r.rate_cents / 100).toFixed(2)}/hr`;

export function requireRef(row, field, what) {
  if (!row) throw invalid([`${field}: no such ${what}`]);
}
