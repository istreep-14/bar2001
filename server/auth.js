import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(s).digest();

// With no token configured, every request is allowed (loopback-only dev).
export function isAuthorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopback = (host) => LOOPBACK.has(host);
