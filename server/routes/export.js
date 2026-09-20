import { catalogStore } from '../catalog.js';
import { shiftStore } from '../shiftStore.js';
import { listStore } from '../lists.js';
import { employeeStore } from '../employees.js';

// Full dump of every table, deleted shifts included. `version` is the schema version.
export function registerExport(router, db) {
  const catalog = catalogStore(db);
  const shifts = shiftStore(db);
  const lists = listStore(db);
  const employees = employeeStore(db);
  router.add('GET', '/api/v1/export', () => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    exported_at: new Date().toISOString(),
    venues: catalog.listVenues({ includeArchived: true }),
    jobs: catalog.listJobs({ includeArchived: true }),
    wage_rates: catalog.listWageRates(),
    locations: lists.locations.list({ includeArchived: true }),
    employees: employees.list({ includeArchived: true }),
    income_categories: lists.incomeCategories.list({ includeArchived: true }),
    shifts: shifts.all(),
  }));
}
