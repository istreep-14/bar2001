import { randomUUID } from 'node:crypto';

// In-process change feed. Stores emit after a write commits; the SSE endpoint fans the
// events out. A short ring buffer lets a new dashboard tab show recent activity.
export function createBus({ keep = 100 } = {}) {
  const listeners = new Set();
  const ring = [];
  const instance = randomUUID(); // changes on every server start, so clients can tell restarts apart
  let seq = 0;
  return {
    instance,
    emit(event) {
      const e = { seq: ++seq, at: new Date().toISOString(), ...event };
      ring.push(e);
      if (ring.length > keep) ring.shift();
      for (const listener of listeners) listener(e);
      return e;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recent: () => [...ring],
  };
}

// Writes made by another process (the import script, the sqlite3 CLI) never pass through
// this process's stores. SQLite bumps PRAGMA data_version on a connection whenever a
// *different* connection commits, so polling it catches exactly those writes.
export function createExternalWatch(db, bus) {
  const read = () => db.prepare('PRAGMA data_version').get().data_version;
  let last = read();
  let timer = null;
  const watch = {
    check() {
      const v = read();
      if (v === last) return false;
      last = v;
      bus.emit({ entity: 'db', op: 'external', label: 'database changed by another process' });
      return true;
    },
    start(ms = 1000) {
      timer = setInterval(() => watch.check(), ms);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
  return watch;
}
