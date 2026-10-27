import { describe, expect, it } from 'vitest';
import { CliSessionStore, type CliSessionStorage } from './cli-session-store';

const first = { state: 'creating', sessionId: 'desktop-one', runId: 'runtime-one' } as const;
const next = { state: 'established', sessionId: 'desktop-one' } as const;
function storage() {
  const files = new Map<string, string>();
  const io: CliSessionStorage = {
    async load(root) { return files.get(root) ?? null; },
    async save(root, expected, json) {
      const current = files.get(root) ?? null;
      if (current !== expected) return { status: 'conflict', current };
      files.set(root, json); return { status: 'written' };
    },
  };
  return { files, io };
}

describe('durable CLI session associations', () => {
  it('reads an old workspace without creating metadata and restores the exact association', async () => {
    const { files, io } = storage();
    const lease = await new CliSessionStore(io).open('root', 'conversation');
    expect(lease.binding).toEqual({ state: 'none' }); expect(files.size).toBe(0);
    await lease.save(first); await lease.save(next);
    const restored = await new CliSessionStore(io).open('root', 'conversation');
    expect(restored.binding).toEqual(next);
    await restored.save({ state: 'none' });
    expect((await new CliSessionStore(io).open('root', 'conversation')).binding).toEqual({ state: 'none' });
  });
  it('merges another conversation but refuses a changed same-conversation snapshot', async () => {
    const { files, io } = storage(); const a = new CliSessionStore(io); const b = new CliSessionStore(io);
    const a1 = await a.open('root', 'a'); const b1 = await b.open('root', 'b');
    const stale = await b.open('root', 'a');
    await a1.save(first); await b1.save({ state: 'established', sessionId: 'desktop-two' });
    const before = files.get('root');
    await expect(stale.save(next)).rejects.toThrow(/changed/);
    expect(files.get('root')).toBe(before);
    expect((await a.open('root', 'a')).binding).toEqual(first);
    expect((await a.open('root', 'b')).binding).toEqual({ state: 'established', sessionId: 'desktop-two' });
  });
  it('rechecks a CAS conflict and preserves a concurrent other-conversation change', async () => {
    const { files, io } = storage(); const original = io.save; let inject = true;
    io.save = async (root, expected, json) => {
      if (inject) { inject = false; files.set(root, JSON.stringify({ schemaVersion: 1, sessions: { other: next } })); }
      return original(root, expected, json);
    };
    await (await new CliSessionStore(io).open('root', 'mine')).save(first);
    expect(JSON.parse(files.get('root')!).sessions).toEqual({ mine: first, other: next });
  });
  it.each(['{broken', '{"schemaVersion":2,"sessions":{}}',
    '{"schemaVersion":1,"sessions":{"a":{"state":"established","sessionId":"../../escape"}}}',
    '{"schemaVersion":1,"sessions":{},"unrecognized":true}'])('rejects invalid metadata without replacing it: %s', async raw => {
    const { files, io } = storage(); files.set('root', raw);
    await expect(new CliSessionStore(io).open('root', 'a')).rejects.toThrow(/metadata/);
    expect(files.get('root')).toBe(raw);
  });
  it('keeps a failed write retryable and isolates identical conversation IDs by workspace', async () => {
    const { io } = storage(); const original = io.save; let fail = true;
    io.save = async (...args) => { if (fail) throw new Error('disk full'); return original(...args); };
    const owner = new CliSessionStore(io); const lease = await owner.open('a', 'same');
    await expect(lease.save(first)).rejects.toThrow('disk full');
    fail = false; await lease.save(first);
    expect((await owner.open('b', 'same')).binding).toEqual({ state: 'none' });
    expect((await owner.open('a', 'same')).binding).toEqual(first);
  });
  it('serializes rapid callbacks from one conversation without losing the established state', async () => {
    const { io } = storage(); const owner = new CliSessionStore(io);
    const lease = await owner.open('root', 'same');
    await Promise.all([lease.save(first), lease.save(next)]);
    expect((await owner.open('root', 'same')).binding).toEqual(next);
  });
  it('does not overwrite a same-conversation update arriving during CAS', async () => {
    const { files, io } = storage();
    const other = JSON.stringify({ schemaVersion: 1, sessions: { mine: next } });
    io.save = async () => { files.set('root', other); return { status: 'conflict', current: other }; };
    const lease = await new CliSessionStore(io).open('root', 'mine');
    await expect(lease.save(first)).rejects.toThrow(/changed/);
    expect(files.get('root')).toBe(other);
  });
});
