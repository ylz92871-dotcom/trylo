import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function createStore(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ??= { version: 1, users: [], devices: [], sessions: [] };
  if (state.version !== 1 || !['users', 'devices', 'sessions'].every(key => Array.isArray(state[key]))) throw new Error('Invalid relay state; refusing to overwrite it.');
  // Keep the original JSON untouched for rollback. SQLite becomes the only writer.
  const db = new DatabaseSync(path.join(directory, 'accounts.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS relay_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  const select = db.prepare('SELECT value FROM relay_state WHERE id=1');
  const insert = db.prepare('INSERT OR IGNORE INTO relay_state(id,value) VALUES(1,?)');
  insert.run(JSON.stringify(state));
  await fs.chmod(path.join(directory, 'accounts.sqlite'), 0o600);
  let queue = Promise.resolve();
  return {
    read: () => JSON.parse(select.get().value),
    // Trusted service modules share the same connection and writer queue. Keep
    // these callbacks SQL-only; never hold a transaction across provider I/O.
    sqlRead: operation => operation(db),
    sqlWrite(operation) {
      const next = queue.then(() => {
        if (operation.constructor?.name === 'AsyncFunction') throw new Error('SQL transactions must be synchronous.');
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = operation(db);
          if (result && typeof result.then === 'function') throw new Error('SQL transactions must be synchronous.');
          db.exec('COMMIT'); return result;
        } catch (failure) { db.exec('ROLLBACK'); throw failure; }
      });
      queue = next.catch(() => {}); return next;
    },
    close: async () => { await queue; db.close(); },
    change(operation) {
      const next = queue.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const candidate = JSON.parse(select.get().value);
          const result = await operation(candidate);
          db.prepare('UPDATE relay_state SET value=? WHERE id=1').run(JSON.stringify(candidate));
          db.exec('COMMIT');
          return result;
        } catch (failure) { db.exec('ROLLBACK'); throw failure; }
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
