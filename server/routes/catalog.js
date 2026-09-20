import { catalogStore } from '../catalog.js';
import { created, invalid, notFound } from '../http.js';
import { validateVenue, validateJob, validateWageRate } from '../validate.js';

const checked = ({ value, problems }) => {
  if (problems.length) throw invalid(problems);
  return value;
};
const found = (row, what) => {
  if (!row) throw notFound(what);
  return row;
};
const flag = (query, name) => query.get(name) === '1';

export function registerCatalog(router, db, bus) {
  const store = catalogStore(db, { emit: bus?.emit });
  const P = '/api/v1';

  router.add('GET', `${P}/venues`, ({ query }) => ({ venues: store.listVenues({ includeArchived: flag(query, 'include_archived') }) }));
  router.add('POST', `${P}/venues`, ({ body }) => created(store.createVenue(checked(validateVenue(body)))));
  router.add('GET', `${P}/venues/:id`, ({ params }) => found(store.getVenue(params.id), 'venue'));
  router.add('PATCH', `${P}/venues/:id`, ({ params, body }) => store.updateVenue(params.id, checked(validateVenue(body, { partial: true }))));
  router.add('DELETE', `${P}/venues/:id`, ({ params }) => store.deleteVenue(params.id));

  router.add('GET', `${P}/jobs`, ({ query }) => ({
    jobs: store.listJobs({ venue_id: query.get('venue_id') ?? undefined, includeArchived: flag(query, 'include_archived') }),
  }));
  router.add('POST', `${P}/jobs`, ({ body }) => created(store.createJob(checked(validateJob(body)))));
  router.add('GET', `${P}/jobs/:id`, ({ params }) => found(store.getJob(params.id), 'job'));
  router.add('PATCH', `${P}/jobs/:id`, ({ params, body }) => store.updateJob(params.id, checked(validateJob(body, { partial: true }))));
  router.add('DELETE', `${P}/jobs/:id`, ({ params }) => store.deleteJob(params.id));

  router.add('GET', `${P}/wage-rates`, () => ({ wage_rates: store.listWageRates() }));
  router.add('POST', `${P}/wage-rates`, ({ body }) => created(store.createWageRate(checked(validateWageRate(body)))));
  router.add('GET', `${P}/wage-rates/:id`, ({ params }) => found(store.getWageRate(params.id), 'wage rate'));
  router.add('PATCH', `${P}/wage-rates/:id`, ({ params, body }) =>
    store.updateWageRate(params.id, checked(validateWageRate(body, { partial: true }))));
  router.add('DELETE', `${P}/wage-rates/:id`, ({ params }) => void store.deleteWageRate(params.id));
}

