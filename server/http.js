export class HttpError extends Error {
  constructor(status, code, problems = []) {
    super(problems.length ? `${code}: ${problems.join('; ')}` : code);
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

export const invalid = (problems) => new HttpError(400, 'VALIDATION', problems);
export const notFound = (what = 'resource') => new HttpError(404, 'NOT_FOUND', [`${what} not found`]);
export const conflict = (problems) => new HttpError(409, 'CONFLICT', problems);

// Handlers return a plain value (200), a Reply for another status, or undefined (204).
export class Reply {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}
export const created = (body) => new Reply(201, body);

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const keys = [];
      const source = pattern.replace(/:([a-z_]+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      });
      routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler });
    },
    match(method, pathname) {
      let pathMatched = false;
      for (const route of routes) {
        const m = route.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = {};
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(m[i + 1]);
        });
        return { handler: route.handler, params, pathMatched };
      }
      return { handler: null, params: {}, pathMatched };
    },
  };
}
