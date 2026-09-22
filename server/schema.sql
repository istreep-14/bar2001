-- Schema v10. Inputs only: hours, pay, $/hr and averages are never stored.
-- Money is integer cents. Times are local wall-clock 'YYYY-MM-DDTHH:MM' strings (no timezone).
-- This is the whole schema in one file; see server/db.js for how an older database file is handled.

CREATE TABLE venues (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  notes    TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
) STRICT;

CREATE TABLE jobs (
  id       TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues (id),
  title    TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
) STRICT;
CREATE INDEX jobs_venue_id ON jobs (venue_id);

-- Your hourly wage over time: a rate applies from effective_from until the next row. It is one history,
-- not one per job. A shift's estimated wage is derived from it at read time (server/pay.js) and never stored.
CREATE TABLE wage_rates (
  id             TEXT PRIMARY KEY,
  effective_from TEXT NOT NULL UNIQUE CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  rate_cents     INTEGER NOT NULL CHECK (rate_cents >= 0),
  note           TEXT
) STRICT;

-- Pick lists that feed the shift form's autofill. A name is unique ignoring case. A list entry that a
-- shift refers to is archived instead of deleted, so history keeps resolving.
CREATE TABLE locations (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 100),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
) STRICT;

-- The people you work with. Unlike the two lists around it this is a real table that keeps growing columns:
-- name is the one required, canonical handle; everything else is detail. `is_me` flags your own row among
-- them (at most one, enforced by the partial unique index below) for whichever features want to tell you
-- apart from a coworker without a separate "am I on this shift" concept.
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
CREATE UNIQUE INDEX employees_is_me ON employees (is_me) WHERE is_me = 1;

-- Zero to many roles per employee ("Bartender" or no roles at all counts as a bartender in a shift's staff
-- totals, same free-text rule the single `role` column used to enforce). Same join-table shape as `shift_tags`.
CREATE TABLE employee_roles (
  employee_id TEXT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 50),
  PRIMARY KEY (employee_id, role)
) STRICT;

-- The kinds of income a shift can record (Tips, Cash, Venmo, Paycheck...). Same rules as the two lists
-- above, plus `system`: Tips is built in, at a fixed id, and is what an entry with no type means.
CREATE TABLE income_categories (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 100),
  system   INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
) STRICT;
INSERT INTO income_categories (id, name, system) VALUES ('00000000-0000-4000-8000-000000000001', 'Tips', 1);

-- Every field below notes/external_ref/created/updated/deleted is optional: a shift can be logged with as
-- little as a date, or nothing at all yet. There is no "double" shift type; a shift that used to be a double
-- (a day part and a night part worked back to back) is just two separate shifts now.
CREATE TABLE shifts (
  id            TEXT PRIMARY KEY,          -- client-generated UUID
  job_id        TEXT REFERENCES jobs (id), -- optional: the shift form no longer asks for a venue or job
  location_id   TEXT REFERENCES locations (id),
  work_date     TEXT CHECK (work_date IS NULL OR work_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_at      TEXT CHECK (start_at IS NULL OR start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
  end_at        TEXT CHECK (end_at   IS NULL OR end_at   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
  shift_type    TEXT CHECK (shift_type IS NULL OR shift_type IN ('day', 'night')),
  notes         TEXT,
  external_ref  TEXT UNIQUE,               -- import idempotency only, never set via the API
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  CHECK ((start_at IS NULL) = (end_at IS NULL)),
  CHECK (start_at IS NULL OR end_at > start_at)
) STRICT;
CREATE INDEX shifts_start_at ON shifts (start_at);
CREATE INDEX shifts_work_date ON shifts (work_date);
CREATE INDEX shifts_job_id ON shifts (job_id);
CREATE INDEX shifts_location_id ON shifts (location_id);

-- Zero to many breaks per shift. Each is a time range (start_at + end_at) or just a length in minutes,
-- never both. That a range sits inside the shift, that ranges don't overlap and that the breaks fit in
-- the shift are checked by the validator (they span two tables).
CREATE TABLE shift_breaks (
  id       TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  start_at TEXT CHECK (start_at IS NULL OR start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
  end_at   TEXT CHECK (end_at   IS NULL OR end_at   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
  minutes  INTEGER CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 1440),
  CHECK ((start_at IS NULL) = (end_at IS NULL)),
  CHECK ((start_at IS NULL) != (minutes IS NULL)),
  CHECK (start_at IS NULL OR end_at > start_at)
) STRICT;
CREATE INDEX shift_breaks_shift_id ON shift_breaks (shift_id);

-- Who worked a shift with you. Their times and the tips they made are optional; times are both or neither.
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
CREATE INDEX shift_employees_employee_id ON shift_employees (employee_id);

-- Parties during a shift. That a shift has one is the point (a yes/no to compare shifts by); every detail is
-- optional. A shift can have more than one.
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

CREATE TABLE shift_tags (
  shift_id TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  tag      TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 50),
  PRIMARY KEY (shift_id, tag)
) STRICT;

-- Income entries. `category_id` says what kind (Tips, Cash...).
CREATE TABLE money_entries (
  id          TEXT PRIMARY KEY,
  shift_id    TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES income_categories (id),
  value_cents INTEGER NOT NULL CHECK (value_cents >= 0)
) STRICT;
CREATE INDEX money_entries_shift_id ON money_entries (shift_id);
