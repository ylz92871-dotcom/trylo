import type { CliSessionBinding } from '../host-adapter/cli-session-binding';

type StoredBinding = Exclude<CliSessionBinding, { state: 'none' }>;
interface Document { schemaVersion: 1; sessions: Record<string, StoredBinding> }
export type CliSessionWrite = { status: 'written' } | { status: 'conflict'; current: string | null };
export interface CliSessionStorage {
  load(root: string): Promise<string | null>;
  save(root: string, expected: string | null, json: string): Promise<CliSessionWrite>;
}
export interface CliSessionLease {
  readonly binding: CliSessionBinding;
  save(binding: CliSessionBinding): Promise<void>;
}

function invalid(): never { throw new Error('Invalid CLI session metadata; the original file was preserved.'); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function identity(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
    && new TextEncoder().encode(value).length <= max;
}
function binding(value: unknown): value is StoredBinding {
  if (!record(value) || typeof value.sessionId !== 'string'
    || !/^desktop-[A-Za-z0-9_.-]+$/.test(value.sessionId) || value.sessionId.length > 160) return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.state === 'established') return keys === 'sessionId,state';
  if (value.state === 'creating') return keys === 'runId,sessionId,state' && identity(value.runId, 4096);
  return value.state === 'unknown' && keys === 'reason,sessionId,state' && identity(value.reason, 4096);
}
function parse(raw: string | null): Document {
  if (raw === null) return { schemaVersion: 1, sessions: Object.create(null) as Record<string, StoredBinding> };
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) invalid();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { invalid(); }
  if (!record(value) || value.schemaVersion !== 1 || !record(value.sessions)
    || Object.keys(value).sort().join(',') !== 'schemaVersion,sessions') invalid();
  for (const [id, item] of Object.entries(value.sessions)) if (!identity(id, 512) || !binding(item)) invalid();
  return value as unknown as Document;
}
function same(a: StoredBinding | undefined, b: StoredBinding | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.state === b.state && a.sessionId === b.sessionId
    && (a.state !== 'creating' || b.state === 'creating' && a.runId === b.runId)
    && (a.state !== 'unknown' || b.state === 'unknown' && a.reason === b.reason);
}

/** Serializes local writers; native CAS also protects independently created owners. */
export class CliSessionStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly storage: CliSessionStorage) {}

  private async queue<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queues.set(root, pending);
    try { return await pending; }
    finally { if (this.queues.get(root) === pending) this.queues.delete(root); }
  }

  async open(root: string, conversationId: string): Promise<CliSessionLease> {
    if (!identity(conversationId, 512)) invalid();
    let expected = await this.queue(root, async () => {
      const document = parse(await this.storage.load(root));
      return Object.hasOwn(document.sessions, conversationId) ? document.sessions[conversationId] : undefined;
    });
    const initial: CliSessionBinding = expected ?? { state: 'none' };
    return { binding: initial, save: value => this.queue(root, async () => {
      const desired = value.state === 'none' ? undefined : value;
      if (desired !== undefined && !binding(desired)) invalid();
      let raw = await this.storage.load(root);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const document = parse(raw);
        const current = Object.hasOwn(document.sessions, conversationId) ? document.sessions[conversationId] : undefined;
        if (!same(expected, current)) throw new Error('CLI session metadata changed in another owner; reload before continuing.');
        if (same(current, desired)) { expected = desired; return; }
        const sessions = { ...document.sessions };
        if (desired) Object.defineProperty(sessions, conversationId, { value: desired, enumerable: true, configurable: true });
        else delete sessions[conversationId];
        const reply = await this.storage.save(root, raw, JSON.stringify({ schemaVersion: 1, sessions }));
        if (reply.status === 'written') { expected = desired; return; }
        raw = reply.current;
      }
      throw new Error('CLI session metadata kept changing; retry after the other owner finishes.');
    }) };
  }
}
