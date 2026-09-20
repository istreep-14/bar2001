// Raw row counts and server facts for the dashboard header. Counts only, nothing derived.
export function registerStats(router, db, { startedAt = new Date() } = {}) {
  const n = (sql) => db.prepare(sql).get().n;
  router.add('GET', '/api/v1/stats', () => ({
    schema_version: db.prepare('PRAGMA user_version').get().user_version,
    now: new Date().toISOString(),
    started_at: startedAt.toISOString(),
    counts: {
      venues: n('SELECT COUNT(*) AS n FROM venues'),
      jobs: n('SELECT COUNT(*) AS n FROM jobs'),
      wage_rates: n('SELECT COUNT(*) AS n FROM wage_rates'),
      shifts: n('SELECT COUNT(*) AS n FROM shifts WHERE deleted_at IS NULL'),
      shifts_deleted: n('SELECT COUNT(*) AS n FROM shifts WHERE deleted_at IS NOT NULL'),
      money_entries: n('SELECT COUNT(*) AS n FROM money_entries'),
      shift_tags: n('SELECT COUNT(*) AS n FROM shift_tags'),
      shift_breaks: n('SELECT COUNT(*) AS n FROM shift_breaks'),
      locations: n('SELECT COUNT(*) AS n FROM locations'),
      employees: n('SELECT COUNT(*) AS n FROM employees'),
      parties: n('SELECT COUNT(*) AS n FROM parties'),
      income_categories: n('SELECT COUNT(*) AS n FROM income_categories'),
    },
  }));
}
