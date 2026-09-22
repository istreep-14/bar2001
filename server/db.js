import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIPS_CATEGORY_ID } from './pay.js';

// The schema is one file. While the model is still settling there are few migrations: a database
// file from a schema version with no migration path is renamed aside (never modified or deleted) and a
// fresh one is created in its place. Bump this whenever schema.sql changes incompatibly, and add an
// entry to MIGRATIONS below only when the data is worth carrying over.
export const SCHEMA_VERSION = 10;
const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export { TIPS_CATEGORY_ID };

// One step per schema version, keyed by the version it upgrades FROM. Each runs in a transaction, on a file
// that was copied to <name>.v<version>-<time>.bak first. A test checks that a migrated database has the
// same tables and columns as a fresh one, so these can't drift from schema.sql.
export const MIGRATIONS = {
  // v4 -> v5: income has types. Every existing entry was tips, so it gets the built-in Tips category.
  4(db) {
    db.exec(`
      CREATE TABLE income_categories (
        id       TEXT PRIMARY KEY,
        name     TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 100),
        system   INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
      ) STRICT;
      INSERT INTO income_categories (id, name, system) VALUES ('${TIPS_CATEGORY_ID}', 'Tips', 1);
      DROP INDEX money_entries_shift_id;
      ALTER TABLE money_entries RENAME TO money_entries_v4;
      CREATE TABLE money_entries (
        id          TEXT PRIMARY KEY,
        shift_id    TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES income_categories (id),
        value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
        part        TEXT CHECK (part IS NULL OR part IN ('day', 'night'))
      ) STRICT;
      INSERT INTO money_entries (id, shift_id, category_id, value_cents, part)
        SELECT id, shift_id, '${TIPS_CATEGORY_ID}', value_cents, part FROM money_entries_v4 ORDER BY rowid;
      DROP TABLE money_entries_v4;
      CREATE INDEX money_entries_shift_id ON money_entries (shift_id);
    `);
  },
  // v5 -> v6: the wage history is one list instead of one per job. Where two jobs had a rate from the same
  // date, the first one entered is kept.
  5(db) {
    db.exec(`
      ALTER TABLE wage_rates RENAME TO wage_rates_v5;
      CREATE TABLE wage_rates (
        id             TEXT PRIMARY KEY,
        effective_from TEXT NOT NULL UNIQUE CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        rate_cents     INTEGER NOT NULL CHECK (rate_cents >= 0),
        note           TEXT
      ) STRICT;
      INSERT INTO wage_rates (id, effective_from, rate_cents, note)
        SELECT id, effective_from, rate_cents, note FROM wage_rates_v5
        WHERE rowid IN (SELECT MIN(rowid) FROM wage_rates_v5 GROUP BY effective_from) ORDER BY rowid;
      DROP TABLE wage_rates_v5;
    `);
  },
  // v6 -> v7: coworkers become employees (a real table that can grow columns, so it gains a role and notes), and who
  // was on a shift can carry their times and tips. Every existing link is kept, with no times yet. Parties are new.
  6(db) {
    db.exec(`
      ALTER TABLE coworkers RENAME TO employees;
      ALTER TABLE employees ADD COLUMN role TEXT CHECK (role IS NULL OR length(role) BETWEEN 1 AND 50);
      ALTER TABLE employees ADD COLUMN notes TEXT;
      CREATE TABLE shift_employees (
        shift_id    TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employees (id),
        start_at    TEXT CHECK (start_at IS NULL OR start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
        end_at      TEXT CHECK (end_at   IS NULL OR end_at   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
        tips_cents  INTEGER CHECK (tips_cents IS NULL OR tips_cents >= 0),
        PRIMARY KEY (shift_id, employee_id),
        CHECK ((start_at IS NULL) = (end_at IS NULL)),
        CHECK (start_at IS NULL OR end_at > start_at)
      ) STRICT;
      INSERT INTO shift_employees (shift_id, employee_id) SELECT shift_id, coworker_id FROM shift_coworkers;
      DROP TABLE shift_coworkers;
      CREATE INDEX shift_employees_employee_id ON shift_employees (employee_id);
      CREATE TABLE parties (
        id       TEXT PRIMARY KEY,
        shift_id TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
        name     TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200),
        guests   INTEGER CHECK (guests IS NULL OR guests BETWEEN 1 AND 100000),
        start_at TEXT CHECK (start_at IS NULL OR start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
        end_at   TEXT CHECK (end_at   IS NULL OR end_at   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
        notes    TEXT,
        CHECK ((start_at IS NULL) = (end_at IS NULL)),
        CHECK (start_at IS NULL OR end_at > start_at)
      ) STRICT;
      CREATE INDEX parties_shift_id ON parties (shift_id);
    `);
  },
  // v8 -> v9: employees grow first/last/id_number/manager/is_me, and role becomes many-valued
  // (employee_roles, same join-table shape as shift_tags). Every existing role is kept as one row.
  //
  // Copies the old rows into a plain staging table rather than renaming `employees` out of the way: SQLite's
  // ALTER TABLE RENAME rewrites *other* tables' REFERENCES clauses to follow the new name, so a rename here
  // would silently repoint shift_employees.employee_id at "employees_v8" instead of the freshly created
  // `employees` table. Dropping and recreating under the original name leaves shift_employees' REFERENCES
  // employees clause (which is never touched) resolving correctly again the moment the new table exists.
  8(db) {
    db.exec(`
      CREATE TABLE employees_v8_old AS SELECT id, name, archived, role, notes FROM employees;
      DROP TABLE employees;
      CREATE TABLE employees (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 100),
        archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        first      TEXT CHECK (first IS NULL OR length(first) BETWEEN 1 AND 60),
        last       TEXT CHECK (last IS NULL OR length(last) BETWEEN 1 AND 60),
        id_number  TEXT CHECK (id_number IS NULL OR length(id_number) BETWEEN 1 AND 50),
        manager    INTEGER NOT NULL DEFAULT 0 CHECK (manager IN (0, 1)),
        is_me      INTEGER NOT NULL DEFAULT 0 CHECK (is_me IN (0, 1)),
        notes      TEXT
      ) STRICT;
      INSERT INTO employees (id, name, archived, notes)
        SELECT id, name, archived, notes FROM employees_v8_old ORDER BY rowid;
      CREATE UNIQUE INDEX employees_is_me ON employees (is_me) WHERE is_me = 1;
      CREATE TABLE employee_roles (
        employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 50),
        PRIMARY KEY (employee_id, role)
      ) STRICT;
      INSERT INTO employee_roles (employee_id, role)
        SELECT id, role FROM employees_v8_old WHERE role IS NOT NULL AND trim(role) != '' ORDER BY rowid;
      DROP TABLE employees_v8_old;
    `);
  },
  // v9 -> v10: repairs a database that ran the buggy first cut of the v8->v9 step above, where
  // ALTER TABLE employees RENAME TO employees_v8 silently repointed shift_employees.employee_id at
  // "employees_v8" (SQLite rewrites other tables' REFERENCES on a rename), which was then dropped —
  // leaving shift_employees referencing a table that no longer exists. Recreates shift_employees with
  // the correct REFERENCES employees clause; a fresh v9 database (which never had the bug) just gets
  // the same table back unchanged.
  9(db) {
    db.exec(`
      CREATE TABLE shift_employees_v9fix (
        shift_id    TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES employees (id),
        start_at    TEXT CHECK (start_at IS NULL OR start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
        end_at      TEXT CHECK (end_at   IS NULL OR end_at   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
        tips_cents  INTEGER CHECK (tips_cents IS NULL OR tips_cents >= 0),
        PRIMARY KEY (shift_id, employee_id),
        CHECK ((start_at IS NULL) = (end_at IS NULL)),
        CHECK (start_at IS NULL OR end_at > start_at)
      ) STRICT;
      INSERT INTO shift_employees_v9fix SELECT shift_id, employee_id, start_at, end_at, tips_cents FROM shift_employees;
      DROP INDEX shift_employees_employee_id;
      DROP TABLE shift_employees;
      ALTER TABLE shift_employees_v9fix RENAME TO shift_employees;
      CREATE INDEX shift_employees_employee_id ON shift_employees (employee_id);
    `);
  },
};

// Apply schema.sql to a brand new (or just-emptied) file. Called under the upgrade lock for a real
// file, so two processes racing to create the same database can't both try to create its tables.
function ensureSchema(path) {
  const db = new DatabaseSync(path);
  try {
    if (db.prepare('PRAGMA user_version').get().user_version === 0) {
      transaction(db, () => {
        db.exec(readFileSync(SCHEMA_FILE, 'utf8'));
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
  } finally {
    db.close();
  }
}

export function openDb(path = ':memory:') {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
    withUpgradeLock(path, () => {
      migrateIfPossible(path);
      setAsideIfIncompatible(path);
      ensureSchema(path);
    });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // Only reached for :memory: (a real file's schema was already ensured, under the lock, above).
  if (db.prepare('PRAGMA user_version').get().user_version === 0) {
    transaction(db, () => {
      db.exec(readFileSync(SCHEMA_FILE, 'utf8'));
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
  return db;
}

// Upgrading a file (migrating it, or setting it aside) must happen in one process at a time: a second process
// copying or reading it mid-migration fails or, worse, saves a copy under the wrong version. The first process
// to start makes `<db>.migrating` (creating it either succeeds or fails, atomically); the others wait for it to
// go away and then find the work already done. A lock left by a crashed process is ignored after a minute.
function withUpgradeLock(path, work) {
  const lock = `${path}.migrating`;
  const give_up = Date.now() + 30_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock);
      } catch { /* it was just released */ }
      if (Date.now() > give_up) throw new Error(`Waited 30s for another process to finish upgrading ${path} (delete ${lock} if none is)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // sleep 25 ms, synchronously
    }
  }
  try {
    work();
  } finally {
    unlinkSync(lock);
  }
}

// Bring an older file up to SCHEMA_VERSION if every step on the way has a migration. The original is
// copied first (a real backup, taken with VACUUM INTO so it is consistent even with the WAL in play).
function migrateIfPossible(path) {
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const start = db.prepare('PRAGMA user_version').get().user_version;
    if (start === 0 || start >= SCHEMA_VERSION) return;
    for (let v = start; v < SCHEMA_VERSION; v++) if (!MIGRATIONS[v]) return; // a gap: leave it to setAsideIfIncompatible

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(dirname(path), `${basename(path).replace(/\.db$/, '')}.v${start}-${stamp}.bak`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    db.exec('PRAGMA foreign_keys = ON');
    for (let v = start; v < SCHEMA_VERSION; v++) {
      transaction(db, () => {
        MIGRATIONS[v](db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`migration v${v} to v${v + 1} left ${broken.length} broken reference(s)`);
      });
    }
    console.log(`Database migrated from schema v${start} to v${SCHEMA_VERSION}. The original is kept at ${backup}`);
  } finally {
    db.close();
  }
}

// A file that already has a different schema version is moved to <name>.v<version>-<time>.db (with
// its -wal/-shm files, so nothing is stranded) and a new database is started.
function setAsideIfIncompatible(path) {
  if (!existsSync(path)) return;
  const probe = new DatabaseSync(path);
  let version;
  try {
    version = probe.prepare('PRAGMA user_version').get().user_version;
  } finally {
    probe.close();
  }
  if (version === 0 || version === SCHEMA_VERSION) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aside = join(dirname(path), `${basename(path).replace(/\.db$/, '')}.v${version}-${stamp}.db`);
  renameSync(path, aside);
  for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) renameSync(path + suffix, aside + suffix);
  console.log(`Database schema v${version} is not v${SCHEMA_VERSION}: moved it aside to ${aside} and started a new database.`);
}

// node:sqlite is synchronous on one connection, so a request handler that runs inside
// this can't interleave with another; the transaction is for all-or-nothing writes.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// node:sqlite rejects undefined bind values; treat them as NULL.
export function nulls(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === undefined ? null : v;
  return out;
}
