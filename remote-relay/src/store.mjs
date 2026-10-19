import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function createStore(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ??= { version: 1, users: [], devices: [], sessions: [] };
  if (state.version !== 1 || !['users', 'devices', 'sessions'].every(key => Array.isArray(state[key]))) throw new Error('Invalid relay state; refusing to overwrite it.');
  let queue = Promise.resolve();
  return {
    read: () => state,
    change(operation) {
      const next = queue.then(async () => {
        const candidate = structuredClone(state);
        const result = await operation(candidate);
        const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(candidate), { mode: 0o600 });
          await fs.rename(temporary, filename);
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        state = candidate;
        return result;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
