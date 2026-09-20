import { shiftStore } from '../shiftStore.js';
import { created, invalid, notFound, Reply } from '../http.js';
import { validateId, validateShift, validateMoneyEntry } from '../validate.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const checked = ({ value, problems }) => {
  if (problems.length) throw invalid(problems);
  return value;
};

function idParam(params) {
  return checked(validateId(params.id));
}

function listOptions(query) {
  const problems = [];
  const from = query.get('from') ?? undefined;
  const to = query.get('to') ?? undefined;
  const job_id = query.get('job_id') ?? undefined;
  const location_id = query.get('location_id') ?? undefined;
  const employee_id = query.get('employee_id') ?? undefined;
  const partyFlag = query.get('has_party') ?? undefined;
  if (from && !DATE_RE.test(from)) problems.push('from: must be YYYY-MM-DD');
  if (to && !DATE_RE.test(to)) problems.push('to: must be YYYY-MM-DD');
  if (job_id && !UUID_RE.test(job_id)) problems.push('job_id: must be a UUID');
  if (location_id && !UUID_RE.test(location_id)) problems.push('location_id: must be a UUID');
  if (employee_id && !UUID_RE.test(employee_id)) problems.push('employee_id: must be a UUID');
  if (partyFlag !== undefined && !['0', '1'].includes(partyFlag)) problems.push('has_party: must be 1 or 0');
  let limit = 50;
  if (query.has('limit')) {
    limit = Number(query.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) problems.push('limit: must be an integer from 1 to 200');
  }
  if (problems.length) throw invalid(problems);
  return { from, to, job_id, location_id, employee_id, has_party: partyFlag === undefined ? undefined : partyFlag === '1', limit, cursor: query.get('cursor') ?? undefined, includeDeleted: query.get('include_deleted') === '1' };
}

export function registerShifts(router, db, bus) {
  const store = shiftStore(db, { emit: bus?.emit });
  const P = '/api/v1';

  router.add('GET', `${P}/shifts`, ({ query }) => store.list(listOptions(query)));

  router.add('GET', `${P}/shifts/:id`, ({ params }) => {
    const shift = store.get(idParam(params));
    if (!shift) throw notFound('shift');
    return shift;
  });

  // Idempotent: the client picks the UUID, so a retried request can't duplicate a shift.
  router.add('PUT', `${P}/shifts/:id`, ({ params, body }) => {
    const id = idParam(params);
    const { shift, created: isNew } = store.put(id, checked(validateShift(body)));
    return new Reply(isNew ? 201 : 200, shift);
  });

  router.add('PATCH', `${P}/shifts/:id`, ({ params, body }) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid(['body must be a JSON object']);
    return store.patch(idParam(params), body);
  });

  router.add('DELETE', `${P}/shifts/:id`, ({ params, query }) => {
    store.remove(idParam(params), { hard: query.get('hard') === '1' });
  });

  router.add('POST', `${P}/shifts/:id/money`, ({ params, body }) =>
    created(store.addMoney(idParam(params), checked(validateMoneyEntry(body)))));

  router.add('PATCH', `${P}/money/:id`, ({ params, body }) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid(['body must be a JSON object']);
    return store.patchMoney(idParam(params), body);
  });

  router.add('DELETE', `${P}/money/:id`, ({ params }) => {
    store.removeMoney(idParam(params));
  });
}
