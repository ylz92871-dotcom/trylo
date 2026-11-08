import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../tauri-detect';
import { hostAdapter } from '../index';

interface Identity { revision: number; key?: string }
interface Job { controller: AbortController; promise: Promise<Uint8Array>; consumers: number; settled: boolean }
const inFlight = new Map<string, Job>();
const cache = new Map<string, Uint8Array>();
const identities = new Map<string, Identity>();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let tail: Promise<unknown> = Promise.resolve();
const aborted = (): DOMException => new DOMException('页面预览已取消', 'AbortError');

export function invalidateOfficePages(filePath: string, allowedRoot: string): void {
  const state = identities.get(JSON.stringify([allowedRoot, filePath]));
  if (state?.key) cache.delete(state.key);
  if (state) { state.revision += 1; state.key = undefined; }
}

/** Shared work has separate subscribers. Only the last subscriber's removal
 * cancels the request; a cancelled queued request never starts a converter. */
export async function loadOfficePages(filePath: string, allowedRoot: string, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const identity = JSON.stringify([allowedRoot, filePath]);
  let state = identities.get(identity);
  if (!state) {
    state = { revision: 0 }; identities.set(identity, state);
    if (identities.size > 64) identities.delete(identities.keys().next().value as string);
  }
  const revision = state.revision;
  const stat = await hostAdapter.fs.statFile(filePath);
  signal?.throwIfAborted();
  if (state.revision !== revision) throw aborted();
  const key = JSON.stringify([allowedRoot, filePath, stat.size, stat.modifiedMs, revision]);
  if (state.key && state.key !== key) cache.delete(state.key);
  state.key = key;
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  let job = inFlight.get(key);
  if (!job) {
    if (inFlight.size >= 4) throw new Error('待预览文档较多，请稍后重试');
    job = { controller: new AbortController(), promise: Promise.resolve(new Uint8Array()), consumers: 0, settled: false };
    const owner = job, current = state;
    owner.promise = tail.then(() => {
      owner.controller.signal.throwIfAborted();
      return requestOfficePages(filePath, allowedRoot, owner.controller.signal);
    }).then((bytes) => {
      if (!owner.controller.signal.aborted && identities.get(identity) === current && current.key === key && bytes.byteLength <= MAX_CACHE_BYTES) {
        while (cache.size >= 4 || [...cache.values()].reduce((sum, item) => sum + item.byteLength, 0) + bytes.byteLength > MAX_CACHE_BYTES) {
          const oldest = cache.keys().next().value as string | undefined;
          if (!oldest) break;
          cache.delete(oldest);
        }
        cache.set(key, bytes);
      }
      return bytes;
    }).finally(() => {
      owner.settled = true;
      if (inFlight.get(key) === owner) inFlight.delete(key);
    });
    inFlight.set(key, owner);
    tail = owner.promise.catch(() => undefined);
  }
  const owner = job;
  owner.consumers += 1;
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, bytes?: Uint8Array): void => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', cancel); owner.consumers -= 1;
      if (!owner.consumers && !owner.settled) {
        owner.controller.abort();
        if (inFlight.get(key) === owner) inFlight.delete(key);
      }
      if (error !== undefined) reject(error); else resolve(bytes!);
    };
    const cancel = (): void => finish(aborted());
    signal?.addEventListener('abort', cancel, { once: true });
    void owner.promise.then((bytes) => finish(undefined, bytes), (error: unknown) => finish(error));
    if (signal?.aborted) cancel();
  });
}

async function requestOfficePages(filePath: string, allowedRoot: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (isTauri()) {
    const jobId = crypto.randomUUID();
    const operation = invoke<ArrayBuffer>('preview_office', { filePath, allowedRoot, jobId });
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, bytes?: ArrayBuffer): void => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', cancel);
        if (error !== undefined) reject(error); else resolve(new Uint8Array(bytes!));
      };
      const cancel = (): void => {
        void invoke('preview_office_cancel', { jobId }).catch(() => undefined);
        finish(aborted());
      };
      signal.addEventListener('abort', cancel, { once: true });
      void operation.then((bytes) => finish(undefined, bytes), (error: unknown) => finish(error));
      if (signal.aborted) cancel();
    });
  }
  const response = await fetch('/__dev_preview/office', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, allowedRoot }), signal,
  });
  if (!response.ok) throw new Error(await response.text());
  return new Uint8Array(await response.arrayBuffer());
}
