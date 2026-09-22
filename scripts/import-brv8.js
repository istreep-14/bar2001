// Import shifts, tips and wage rates from a brv8 data/db.json (schema v5).
// Usage: node scripts/import-brv8.js <db.json> [--dry-run] [--db data/bar.db]
//
// Times are the wall-clock times brv8 recorded (no timezone). The shift type comes from brv8's
// shift_type when it recorded Day or Night; there is no "double" any more, so a shift brv8 called
// Double (or left untyped) is classified the same way an untyped one is: by its start time against
// the day/night cutoff. A break becomes a start/end range when brv8 recorded one, otherwise a
// duration (one entry in the shift's breaks). brv8's location becomes an entry in the locations
// list. Only tips are imported (the app now has other income types, but the importer doesn't map brv8's yet); other income (Venmo,
// Consideration, Chump, paycheck) is counted and reported, not imported.
//
// Idempotent: each shift is stored with external_ref 'brv8:<id>' and skipped if already there;
// wage rates and locations are find-or-create. Existing rows are never edited. (brv8's venue and job are
// not imported: the app no longer has a use for them. --venue and --job are accepted and ignored.)
// Not imported (v2 tables): staff, assignments, parties.
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../server/db.js';
import { catalogStore } from '../server/catalog.js';
import { listStore } from '../server/lists.js';
import { shiftStore } from '../server/shiftStore.js';
import { joinLocal, resolveNearSpan } from '../server/time.js';
import { validateShift } from '../server/validate.js';
import { backupDb } from './backup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_CUTOFF_MINUTES = 14 * 60; // brv8's day_cutoff, used only if a shift has no recorded shift_type
const cents = (dollars) => Math.round(Number(dollars) * 100);

function typeOf(shift) {
  const recorded = String(shift.shift_type ?? '').toLowerCase();
  if (recorded === 'day' || recorded === 'night') return recorded;
  // no recorded type, or brv8's "Double" (which no longer exists): guess from the start time
  return shift.start < DAY_CUTOFF_MINUTES ? 'day' : 'night';
}

const hhmm = (minutes) => `${String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// brv8 stores a break as minutes-of-day start/end, or as a duration; either can be missing.
function breakOf(s, start_at, end_at) {
  if (s.break_start != null && s.break_end != null) {
    const break_start = resolveNearSpan(start_at, end_at, hhmm(s.break_start));
    const minutes = s.break_end > s.break_start ? s.break_end - s.break_start : s.break_end + 1440 - s.break_start;
    return [{ start_at: break_start, end_at: joinLocal(break_start.slice(0, 10), Number(break_start.slice(11, 13)) * 60 + Number(break_start.slice(14, 16)) + minutes) }];
  }
  if (s.break_minutes) return [{ minutes: s.break_minutes }];
  return [];
}

// Pure: turn a parsed brv8 db into what would be written, plus what gets skipped and why.
export function planImport(src) {
  const skipped = [];
  const tipsByShift = new Map();
  const notImportedMoney = { count: 0, cents: 0 };
  for (const row of src.income ?? []) {
    if (row.kind !== 'tips') {
      notImportedMoney.count++;
      notImportedMoney.cents += Number.isFinite(cents(row.amount)) ? cents(row.amount) : 0;
      continue;
    }
    if (!row.shift_id) {
      skipped.push({ what: 'tips', id: row.id, reason: `not linked to a shift ($${row.amount}, ${row.date})` });
      continue;
    }
    if (!tipsByShift.has(row.shift_id)) tipsByShift.set(row.shift_id, []);
    tipsByShift.get(row.shift_id).push(row);
  }

  const shifts = [];
  for (const s of src.shifts ?? []) {
    if (s.start == null || s.end == null) {
      skipped.push({ what: 'shift', id: s.id, reason: `no start/end time (${s.date}, ${s.location ?? 'no location'})` });
      continue;
    }
    if (s.end === s.start) {
      skipped.push({ what: 'shift', id: s.id, reason: `start equals end (${s.date})` });
      continue;
    }
    const start_at = joinLocal(s.date, s.start);
    const end_at = joinLocal(s.date, s.end < s.start ? s.end + 1440 : s.end); // past midnight
    const shift_type = typeOf(s);
    const money_entries = [];
    for (const tip of tipsByShift.get(s.id) ?? []) {
      const value = cents(tip.amount);
      if (!Number.isFinite(value) || value < 0) {
        skipped.push({ what: 'tips', id: tip.id, reason: `bad amount ${tip.amount}` });
        continue;
      }
      money_entries.push({ value_cents: value });
    }
    const doc = {
      work_date: s.date,
      start_at,
      end_at,
      shift_type,
      breaks: breakOf(s, start_at, end_at),
      notes: s.notes ?? null,
      tags: s.tags ?? [],
      money_entries,
    };
    const { value, problems } = validateShift(doc);
    if (problems.length) {
      skipped.push({ what: 'shift', id: s.id, reason: `${problems.join('; ')} (${s.date})` });
      continue;
    }
    shifts.push({ ref: `brv8:${s.id}`, location: s.location?.trim() || null, input: value });
  }

  const shiftIds = new Set((src.shifts ?? []).map((s) => s.id));
  return {
    wageRates: (src.wage_rates ?? []).map((w) => ({ effective_from: w.date, rate_cents: cents(w.rate), note: w.note ?? null })),
    shifts,
    skipped,
    notImported: {
      money: notImportedMoney,
      staff: (src.staff ?? []).length,
      assignments: (src.assignments ?? []).length,
      parties: (src.parties ?? []).length,
      shiftsLinkedToParty: (src.shifts ?? []).filter((s) => s.party_id && shiftIds.has(s.id)).length,
    },
  };
}

// Writes the plan. Each shift is its own transaction, so a failure part-way leaves a
// consistent database that a re-run completes.
export function runImport(db, plan) {
  const catalog = catalogStore(db);
  const shifts = shiftStore(db);
  const { locations } = listStore(db);
  for (const rate of plan.wageRates) catalog.ensureWageRate(rate);
  let created = 0;
  let existing = 0;
  for (const { ref, input, location } of plan.shifts) {
    if (shifts.idForExternalRef(ref)) {
      existing++;
      continue;
    }
    const location_id = location ? locations.ensure(location).row.id : null;
    shifts.put(randomUUID(), { ...input, location_id }, { externalRef: ref });
    created++;
  }
  return { created, existing };
}

function summarize(plan) {
  const entries = plan.shifts.flatMap((s) => s.input.money_entries);
  const tips = entries.reduce((sum, e) => sum + e.value_cents, 0) / 100;
  const kinds = plan.shifts.reduce((n, s) => ({ ...n, [s.input.shift_type]: (n[s.input.shift_type] ?? 0) + 1 }), {});
  const { money } = plan.notImported;
  return [
    `${plan.wageRates.length} wage rate(s), ${new Set(plan.shifts.map((s) => s.location).filter(Boolean)).size} location(s)`,
    `${plan.shifts.length} shift(s): ${kinds.day ?? 0} day, ${kinds.night ?? 0} night`,
    `${entries.length} tip entr${entries.length === 1 ? 'y' : 'ies'}, $${tips.toFixed(2)} in tips`,
    `not imported (only tips are mapped so far): ${money.count} other income entr${money.count === 1 ? 'y' : 'ies'}, $${(money.cents / 100).toFixed(2)}`,
    `not imported (v2): ${plan.notImported.staff} staff, ${plan.notImported.assignments} assignments, ${plan.notImported.parties} parties, ${plan.notImported.shiftsLinkedToParty} shift(s) link to a party`,
    `skipped: ${plan.skipped.length}`,
    ...plan.skipped.map((s) => `  - ${s.what} ${s.id}: ${s.reason}`),
  ].join('\n');
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      db: { type: 'string' },
      venue: { type: 'string' }, // no longer used; accepted so old commands still run
      job: { type: 'string' },
      tz: { type: 'string' }, // no longer used: times are wall-clock; accepted so old commands still run
    },
  });
  const [srcPath] = positionals;
  if (!srcPath) {
    console.error('Usage: node scripts/import-brv8.js <db.json> [--dry-run] [--db path]');
    process.exit(1);
  }
  if (values.tz) console.log('Note: --tz is ignored; times are stored as wall-clock times with no timezone.\n');
  const plan = planImport(JSON.parse(readFileSync(resolve(srcPath), 'utf8')));
  console.log(summarize(plan));
  if (values['dry-run']) {
    console.log('\nDry run: nothing written.');
    return;
  }

  const dbPath = resolve(values.db ?? process.env.DB_PATH ?? join(ROOT, 'data', 'bar.db'));
  const hadDb = existsSync(dbPath);
  const db = openDb(dbPath);
  if (hadDb) console.log(`\nBackup: ${backupDb(db, join(dirname(dbPath), 'backups'))}`);
  const result = runImport(db, plan);
  db.close();
  console.log(`\nImported: ${result.created} new shift(s), ${result.existing} already present.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
