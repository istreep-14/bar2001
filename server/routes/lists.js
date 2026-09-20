import { listStore } from '../lists.js';
import { Reply, invalid, notFound } from '../http.js';
import { validateListItem } from '../validate.js';

const checked = ({ value, problems }) => {
  if (problems.length) throw invalid(problems);
  return value;
};

// /locations and /income-categories: the pick lists behind the shift form. POST is find-or-create
// by name (201 when it made one, 200 when the name was already there), so adding is safe to repeat.
export function registerLists(router, db, bus) {
  const stores = listStore(db, { emit: bus?.emit });
  const P = '/api/v1';
  const lists = [
    ['locations', 'locations', stores.locations, 'location'],
    ['income-categories', 'income_categories', stores.incomeCategories, 'income type'],
  ];
  for (const [path, key, list, what] of lists) {
    router.add('GET', `${P}/${path}`, ({ query }) => ({ [key]: list.list({ includeArchived: query.get('include_archived') === '1' }) }));
    router.add('POST', `${P}/${path}`, ({ body }) => {
      const { name } = checked(validateListItem(body));
      const { row, created } = list.ensure(name);
      return new Reply(created ? 201 : 200, row);
    });
    router.add('GET', `${P}/${path}/:id`, ({ params }) => {
      const row = list.get(params.id);
      if (!row) throw notFound(what);
      return row;
    });
    router.add('PATCH', `${P}/${path}/:id`, ({ params, body }) => list.update(params.id, checked(validateListItem(body, { partial: true }))));
    router.add('DELETE', `${P}/${path}/:id`, ({ params }) => list.remove(params.id));
  }
}
