// Trylo Desktop — ServiceManager tests: idempotent start, crash-restart
// backoff (1s/4s/16s, 3 per 5min), and the down notification (spec §5.1).
// Crash detection is exercised through the real path: a failed
// `servicehost_send` fires the client's onConnectionError and the manager
// verifies `servicehost_status`.

import { describe, expect, it, vi } from 'vitest';

import { encodeFrame } from './frames';
import { ServiceManager } from './service-manager';

interface Harness {
  invokes: { cmd: string; args?: Record<string, unknown> }[];
  failCommands: Set<string>;
  setRunning(running: boolean): void;
  /** Simulates the Rust shell forwarding one raw stdout line. */
  emit(line: string): void;
  deps: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  };
}

function createHarness(): Harness {
  const h: Harness = {
    invokes: [],
    failCommands: new Set<string>(),
    setRunning: () => {},
    emit: () => {},
    deps: { invoke: vi.fn(), listen: vi.fn() },
  };
  let running = false;
  h.setRunning = (r: boolean) => {
    running = r;
  };
  const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
    h.invokes.push({ cmd, args });
    if (h.failCommands.has(cmd)) return Promise.reject(new Error(`invoke ${cmd} failed`));
    if (cmd === 'servicehost_status') return Promise.resolve({ running, pid: running ? 42 : null });
    return Promise.resolve({});
  });
  const listen = vi.fn((_event: string, handler: (event: { payload: unknown }) => void) => {
    h.emit = (line: string) => handler({ payload: line });
    return Promise.resolve(() => {});
  });
  h.deps = { invoke, listen };
  return h;
}

const FAST = { restartBackoffMs: [10, 20, 40], restartWindowMs: 60_000, maxRestartsPerWindow: 3 };
const SPAWN = { sidecarsDir: '/r/sidecars', appDataDir: '/ad' };

describe('ServiceManager', () => {
  it('ensureRunning spawns once and is idempotent while running', async () => {
    const h = createHarness();
    h.setRunning(true);
    const manager = new ServiceManager(h.deps, FAST);
    await manager.ensureRunning(SPAWN);
    await manager.ensureRunning(SPAWN);
    const spawns = h.invokes.filter((i) => i.cmd === 'servicehost_spawn');
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.args).toMatchObject({ sidecarsDir: '/r/sidecars', appDataDir: '/ad' });
    expect(manager.currentHealth).toBe('starting'); // ready event hasn't fired yet
  });

  it('coalesces concurrent owners into one spawn', async () => {
    const h = createHarness();
    h.setRunning(true);
    const manager = new ServiceManager(h.deps, FAST);
    await Promise.all([manager.ensureRunning(SPAWN), manager.ensureRunning(SPAWN)]);
    expect(h.invokes.filter((i) => i.cmd === 'servicehost_spawn')).toHaveLength(1);
  });

  it('health flips to ready when the sidecar announces', async () => {
    const h = createHarness();
    h.setRunning(true);
    const manager = new ServiceManager(h.deps, FAST);
    await manager.ensureRunning(SPAWN);
    expect(manager.currentHealth).toBe('starting');
    h.emit(encodeFrame({ version: 1, type: 'event', topic: 'ready', payload: { version: 'test' } }));
    expect(manager.currentHealth).toBe('ready');
  });

  it('restarts with backoff after a crash (send failure + dead status)', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.setRunning(true);
      const manager = new ServiceManager(h.deps, FAST);
      await manager.ensureRunning(SPAWN);
      const spawnsBefore = h.invokes.filter((i) => i.cmd === 'servicehost_spawn').length;

      // The host dies: sends fail and status says not running.
      h.setRunning(false);
      h.failCommands.add('servicehost_send');
      await manager.client.request('pet.disable').catch(() => {});
      h.failCommands.delete('servicehost_send');
      // Let the async connection-error handler finish its status check.
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.currentHealth).toBe('restarting');

      await vi.advanceTimersByTimeAsync(15); // first backoff 10ms
      const spawns = h.invokes.filter((i) => i.cmd === 'servicehost_spawn');
      expect(spawns.length).toBe(spawnsBefore + 1);
      expect(['starting', 'ready']).toContain(manager.currentHealth);

      // Sidecar announces again → ready.
      h.setRunning(true);
      h.emit(encodeFrame({ version: 1, type: 'event', topic: 'ready', payload: {} }));
      expect(manager.currentHealth).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts recovery when the Rust reaper reports a real child exit', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.setRunning(true);
      const manager = new ServiceManager(h.deps, FAST);
      await manager.ensureRunning(SPAWN);
      h.setRunning(false);

      h.emit(encodeFrame({
        version: 1,
        type: 'event',
        topic: 'servicehost.exit',
        payload: { pid: 42, exitCode: 1, reasonCode: 'servicehost_exited' },
      }));
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.currentHealth).toBe('restarting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes down after exhausting the restart budget and notifies once', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.setRunning(false);
      const manager = new ServiceManager(h.deps, FAST);
      const down = vi.fn();
      manager.onDown(down);

      // Crash three times: each failed send schedules a backoff restart.
      for (let i = 0; i < 3; i++) {
        h.failCommands.add('servicehost_send');
        await manager.client.request('pet.disable').catch(() => {});
        h.failCommands.delete('servicehost_send');
        await vi.advanceTimersByTimeAsync(60);
        // Each respawn attempt fails too (status says not running → another
        // cycle). Drive respawn failure via a failed spawn:
        h.failCommands.add('servicehost_spawn');
        // respawn happens on the timer; it fails → health 'down' only after
        // budget exhaustion, otherwise it retries via the next crash signal.
        h.failCommands.delete('servicehost_spawn');
      }
      // After 3 recorded restarts the NEXT crash signal must go down.
      h.failCommands.add('servicehost_send');
      await manager.client.request('pet.disable').catch(() => {});
      h.failCommands.delete('servicehost_send');
      expect(manager.currentHealth).toBe('down');
      expect(down).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() calls servicehost_stop and resets health', async () => {
    const h = createHarness();
    h.setRunning(true);
    const manager = new ServiceManager(h.deps, FAST);
    await manager.ensureRunning(SPAWN);
    await manager.stop();
    expect(h.invokes.some((i) => i.cmd === 'servicehost_stop')).toBe(true);
    expect(manager.currentHealth).toBe('stopped');
  });
});
