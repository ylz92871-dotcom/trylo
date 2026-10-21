import { describe, expect, it, vi } from 'vitest';

import { encodeFrame } from './frames';
import { ServiceManager } from './service-manager';
import { ServicesClient } from './services-client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const OPTIONS = { sidecarsDir: '/resources/sidecars', appDataDir: '/isolated-app' };
const FAST = { restartBackoffMs: [10, 20, 40] };
const EXIT = encodeFrame({ version: 1, type: 'event', topic: 'servicehost.exit', payload: {
  pid: 42, exitCode: 1, reasonCode: 'servicehost_exited',
} });

function managerHarness() {
  let handler: ((event: { payload: unknown }) => void) | undefined;
  let running = false;
  let activeListeners = 0;
  const calls: string[] = [];
  const invoke = vi.fn(async (cmd: string): Promise<unknown> => {
    calls.push(cmd);
    if (cmd === 'servicehost_spawn') running = true;
    if (cmd === 'servicehost_stop') running = false;
    if (cmd === 'servicehost_status') return { running, pid: running ? 42 : null };
    return {};
  });
  const listen = vi.fn(async (_event: string, next: (event: { payload: unknown }) => void) => {
    handler = next;
    activeListeners++;
    return () => { activeListeners--; handler = undefined; };
  });
  return {
    deps: { invoke, listen }, calls,
    emit: (line: string) => handler?.({ payload: line }),
    get running() { return running; },
    get activeListeners() { return activeListeners; },
    setRunning: (value: boolean) => { running = value; },
  };
}

describe('service lifecycle races', () => {
  it('coalesces concurrent listener registration and removes every listener on stop', async () => {
    const release = deferred<void>();
    let listeners = 0;
    const listen = vi.fn(async () => {
      await release.promise;
      listeners++;
      return () => { listeners--; };
    });
    const client = new ServicesClient({ invoke: vi.fn(async () => ({})), listen });
    const first = client.start();
    const second = client.start();
    release.resolve();
    await Promise.all([first, second]);
    const registrations = listen.mock.calls.length;
    await client.stop();
    expect(registrations).toBe(1);
    expect(listeners).toBe(0);
  });

  it('disposes a listener that arrives after stop and ignores its queued frames', async () => {
    const release = deferred<() => void>();
    let handler: ((event: { payload: unknown }) => void) | undefined;
    const unsubscribe = vi.fn();
    const client = new ServicesClient({ invoke: vi.fn(async () => ({})), listen: async (_event, next) => {
      handler = next;
      return release.promise;
    } });
    const ready = vi.fn();
    client.onEvent('ready', ready);
    const starting = client.start();
    await client.stop();
    release.resolve(unsubscribe);
    await starting;
    handler?.({ payload: encodeFrame({ version: 1, type: 'event', topic: 'ready', payload: {} }) });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it('rejects in-flight work when the host exits instead of waiting for the request timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = managerHarness();
      const client = new ServicesClient(h.deps);
      await client.start();
      let settled = false;
      const pending = client.request('pet.disable').catch((error: unknown) => {
        settled = true;
        return error;
      });
      h.emit(EXIT);
      await vi.advanceTimersByTimeAsync(0);
      const rejectedAtExit = settled;
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;
      await client.stop();
      expect(rejectedAtExit).toBe(true);
      expect(error).toMatchObject({ code: 'NOT_CONNECTED' });
    } finally { vi.useRealTimers(); }
  });

  it('keeps a fresh subscription when an older cancelled registration resolves later', async () => {
    const old = deferred<() => void>();
    const oldUnsubscribe = vi.fn();
    const newUnsubscribe = vi.fn();
    const handlers: ((event: { payload: unknown }) => void)[] = [];
    const client = new ServicesClient({ invoke: vi.fn(async () => ({})), listen: async (_event, next) => {
      handlers.push(next);
      return handlers.length === 1 ? old.promise : newUnsubscribe;
    } });
    const ready = vi.fn();
    client.onEvent('ready', ready);
    const starting = client.start();
    await client.stop();
    await client.start();
    old.resolve(oldUnsubscribe);
    await starting;
    const event = { payload: encodeFrame({ version: 1, type: 'event', topic: 'ready', payload: {} }) };
    handlers[0]?.(event);
    handlers[1]?.(event);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
    expect(newUnsubscribe).not.toHaveBeenCalled();
    await client.stop();
    expect(newUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('serializes a requested start after an in-flight stop and supports concurrent stop owners', async () => {
    const h = managerHarness();
    const manager = new ServiceManager(h.deps, FAST);
    await manager.ensureRunning(OPTIONS);
    const release = deferred<void>();
    h.deps.invoke.mockImplementation(async (cmd) => {
      h.calls.push(cmd);
      if (cmd === 'servicehost_stop') { await release.promise; h.setRunning(false); }
      if (cmd === 'servicehost_spawn') h.setRunning(true);
      return {};
    });
    const first = manager.stop();
    const second = manager.stop();
    const restarting = manager.ensureRunning(OPTIONS);
    await Promise.resolve();
    expect(h.calls.filter((cmd) => cmd === 'servicehost_spawn')).toHaveLength(1);
    release.resolve();
    await Promise.all([first, second, restarting]);
    expect(h.calls.filter((cmd) => cmd === 'servicehost_stop')).toHaveLength(1);
    expect(h.calls.filter((cmd) => cmd === 'servicehost_spawn')).toHaveLength(2);
    expect(manager.currentHealth).toBe('ready');
    expect(h.running).toBe(true);
    expect(h.activeListeners).toBe(1);
    await manager.stop();
  });

  it('does not resurrect the host when a crash status query resolves after stop', async () => {
    vi.useFakeTimers();
    try {
      const h = managerHarness();
      const manager = new ServiceManager(h.deps, FAST);
      await manager.ensureRunning(OPTIONS);
      const status = deferred<unknown>();
      h.deps.invoke.mockImplementation(async (cmd) => {
        h.calls.push(cmd);
        return cmd === 'servicehost_status' ? status.promise : {};
      });
      h.emit(EXIT);
      await manager.stop();
      status.resolve({ running: false, pid: null });
      await vi.advanceTimersByTimeAsync(100);
      const health = manager.currentHealth;
      const spawns = h.calls.filter((cmd) => cmd === 'servicehost_spawn').length;
      await manager.stop();
      expect(spawns).toBe(1);
      expect(health).toBe('stopped');
    } finally { vi.useRealTimers(); }
  });

  it('waits for an automatic restart before completing stop and leaves no host behind', async () => {
    vi.useFakeTimers();
    try {
      const h = managerHarness();
      const manager = new ServiceManager(h.deps, FAST);
      await manager.ensureRunning(OPTIONS);
      h.setRunning(false);
      const spawn = deferred<void>();
      h.deps.invoke.mockImplementation(async (cmd) => {
        h.calls.push(cmd);
        if (cmd === 'servicehost_status') return { running: h.running };
        if (cmd === 'servicehost_spawn') { await spawn.promise; h.setRunning(true); }
        if (cmd === 'servicehost_stop') h.setRunning(false);
        return {};
      });
      h.emit(EXIT);
      await vi.advanceTimersByTimeAsync(10);
      expect(h.calls.filter((cmd) => cmd === 'servicehost_spawn')).toHaveLength(2);
      let stopFinished = false;
      const stopping = manager.stop().then(() => { stopFinished = true; });
      await vi.advanceTimersByTimeAsync(0);
      const stoppedBeforeSpawn = stopFinished;
      spawn.resolve();
      await stopping;
      await vi.advanceTimersByTimeAsync(0);
      expect(stoppedBeforeSpawn).toBe(false);
      expect(h.running).toBe(false);
      expect(manager.currentHealth).toBe('stopped');
      expect(h.activeListeners).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('coalesces concurrent crash notifications into one recovery attempt', async () => {
    vi.useFakeTimers();
    try {
      const h = managerHarness();
      const manager = new ServiceManager(h.deps, FAST);
      await manager.ensureRunning(OPTIONS);
      const status = deferred<unknown>();
      h.deps.invoke.mockImplementation(async (cmd) => {
        h.calls.push(cmd);
        return cmd === 'servicehost_status' ? status.promise : {};
      });
      h.emit(EXIT);
      h.emit(EXIT);
      status.resolve({ running: false });
      await vi.advanceTimersByTimeAsync(100);
      const spawns = h.calls.filter((cmd) => cmd === 'servicehost_spawn').length;
      await manager.stop();
      expect(spawns).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('cleans up listeners and pending requests even when the native stop command fails', async () => {
    vi.useFakeTimers();
    try {
      const h = managerHarness();
      const manager = new ServiceManager(h.deps, FAST);
      await manager.ensureRunning(OPTIONS);
      const pending = manager.client.request('pet.disable').catch((error: unknown) => error);
      h.deps.invoke.mockImplementation(async (cmd) => {
        if (cmd === 'servicehost_stop') throw new Error('native stop failed');
        return {};
      });
      await expect(manager.stop()).rejects.toThrow('native stop failed');
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;
      expect(h.activeListeners).toBe(0);
      expect(error).toMatchObject({ code: 'NOT_CONNECTED' });
      expect(manager.currentHealth).toBe('stopped');
    } finally { vi.useRealTimers(); }
  });
});
