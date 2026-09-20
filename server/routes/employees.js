import { employeeStore } from '../employees.js';
import { Reply, invalid, notFound } from '../http.js';
import { validateEmployee } from '../validate.js';

const checked = ({ value, problems }) => {
  if (problems.length) throw invalid(problems);
  return value;
};

// /employees. POST is find-or-create by name (201 when it made one, 200 when the person was already there), so
// adding from the shift form is safe to repeat; PATCH changes any field; DELETE removes, or archives if the person
// worked a shift; GET /summary is what each person has worked so far (derived, never stored).
export function registerEmployees(router, db, bus) {
  const store = employeeStore(db, { emit: bus?.emit });
  const P = '/api/v1/employees';
  router.add('GET', P, ({ query }) => ({ employees: store.list({ includeArchived: query.get('include_archived') === '1' }) }));
  router.add('POST', P, ({ body }) => {
    const { archived: _ignored, ...fields } = checked(validateEmployee(body));
    const { row, created } = store.ensure(fields);
    return new Reply(created ? 201 : 200, row);
  });
  // Before /:id, which would otherwise take "summary" for an id. Derived on every read (per-person shifts, hours, tips).
  router.add('GET', `${P}/summary`, () => ({ summary: store.summary() }));
  router.add('GET', `${P}/:id`, ({ params }) => {
    const row = store.get(params.id);
    if (!row) throw notFound('employee');
    return row;
  });
  router.add('PATCH', `${P}/:id`, ({ params, body }) => store.update(params.id, checked(validateEmployee(body, { partial: true }))));
  router.add('DELETE', `${P}/:id`, ({ params }) => store.remove(params.id));
}
