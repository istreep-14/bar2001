// Consistent snapshot of the database, safe while the server is running (VACUUM INTO).
// Usage: node scripts/backup.js [--db data/bar.db] [--out data/backups]
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../server/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function backupDb(db, dir) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `bar-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

function main() {
  const { values } = parseArgs({ options: { db: { type: 'string' }, out: { type: 'string' } } });
  const dbPath = resolve(values.db ?? process.env.DB_PATH ?? join(ROOT, 'data', 'bar.db'));
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`);
    process.exit(1);
  }
  const db = openDb(dbPath);
  const file = backupDb(db, resolve(values.out ?? join(dirname(dbPath), 'backups')));
  db.close();
  console.log(`Backed up to ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
