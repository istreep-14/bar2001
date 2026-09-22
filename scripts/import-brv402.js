// Import shifts from a brv402 shifts.json export (its Settings > Export button; see
// DATA_MODEL.md §2 in the brv402 repo for the shape). This first pass imports only date, start
// time, end time and tips — no location, party, staff or other income yet.
//
// Usage: node scripts/import-brv402.js <shifts.json> [--dry-run] [--db data/bar.db]
//
// brv402's start/end are minutes-from-midnight, same convention as brv8; an end before the start
// means the shift ran past midnight. brv402's shiftType ('Day'/'Night') is used when recorded;
// otherwise, like brv8, the type is guessed from the start time against a 2 PM cutoff. tips is
// already a rollup (segments, when a shift has them, sum into it), so segments themselves are not
// read. A shift with no start/end, or an end equal to its start, is skipped and reported.
//
// Idempotent: each shift is stored with external_ref 'brv402:<id>' and skipped if already there;
// existing rows are never edited.
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../server/db.js';
import { shiftStore } from '../server/shiftStore.js';
import { joinLocal } from '../server/time.js';
import { validateShift } from '../server/validate.js';
import { backupDb } from './backup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_CUTOFF_MINUTES = 14 * 60; // brv402's default settings.dayCutoff, used only when shiftType wasn't recorded
const cents = (dollars) => Math.round(Number(dollars) * 100);

function typeOf(shift) {
  const recorded = String(shift.shiftType ?? '').toLowerCase();
  if (recorded === 'day' || recorded === 'night') return recorded;
  return shift.start < DAY_CUTOFF_MINUTES ? 'day' : 'night';
}

// Pure: turn a parsed brv402 shifts array into what would be written, plus what gets skipped and why.
export function planImport(shifts) {
  const skipped = [];
  const planned = [];
  for (const s of shifts ?? []) {
    if (s.start == null || s.end == null) {
      skipped.push({ id: s.id, reason: `no start/end time (${s.date})` });
      continue;
    }
    if (s.end === s.start) {
      skipped.push({ id: s.id, reason: `start equals end (${s.date})` });
      continue;
    }
    const start_at = joinLocal(s.date, s.start);
    const end_at = joinLocal(s.date, s.end < s.start ? s.end + 1440 : s.end); // past midnight
    const money_entries = [];
    if (Number.isFinite(s.tips) && s.tips >= 0) money_entries.push({ value_cents: cents(s.tips) });
    const doc = { work_date: s.date, start_at, end_at, shift_type: typeOf(s), money_entries };
    const { value, problems } = validateShift(doc);
    if (problems.length) {
      skipped.push({ id: s.id, reason: `${problems.join('; ')} (${s.date})` });
      continue;
    }
    planned.push({ ref: `brv402:${s.id}`, input: value });
  }
  return { shifts: planned, skipped };
}

// Writes the plan. Each shift is its own transaction, so a failure part-way leaves a
// consistent database that a re-run completes.
export function runImport(db, plan) {
  const shifts = shiftStore(db);
  let created = 0;
  let existing = 0;
  for (const { ref, input } of plan.shifts) {
    if (shifts.idForExternalRef(ref)) {
      existing++;
      continue;
    }
    shifts.put(randomUUID(), input, { externalRef: ref });
    created++;
  }
  return { created, existing };
}

function summarize(plan) {
  const entries = plan.shifts.flatMap((s) => s.input.money_entries);
  const tips = entries.reduce((sum, e) => sum + e.value_cents, 0) / 100;
  const kinds = plan.shifts.reduce((n, s) => ({ ...n, [s.input.shift_type]: (n[s.input.shift_type] ?? 0) + 1 }), {});
  return [
    `${plan.shifts.length} shift(s): ${kinds.day ?? 0} day, ${kinds.night ?? 0} night`,
    `${entries.length} tip entr${entries.length === 1 ? 'y' : 'ies'}, $${tips.toFixed(2)} in tips`,
    `skipped: ${plan.skipped.length}`,
    ...plan.skipped.map((s) => `  - shift ${s.id}: ${s.reason}`),
  ].join('\n');
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      db: { type: 'string' },
    },
  });
  const [srcPath] = positionals;
  if (!srcPath) {
    console.error('Usage: node scripts/import-brv402.js <shifts.json> [--dry-run] [--db path]');
    process.exit(1);
  }
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
