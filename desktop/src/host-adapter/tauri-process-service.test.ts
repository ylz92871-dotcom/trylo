// Trylo Desktop — TauriProcessService unit tests. See
// ARCHITECTURE.md §2.2 + §3 Phase 2 task #3+#4.
//
// The service is a thin wrapper over four Tauri commands. We
// test that the JS side:
//   - forwards spawn args to the Rust command
//   - creates a Channel and routes its messages to onOutput
//   - sends messages and stop calls verbatim

import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const channelInstances: { onmessage: ((msg: unknown) => void) | null }[] = [];

vi.mock('@tauri-apps/api/core', () => {
  class FakeChannel {
    onmessage: ((msg: unknown) => void) | null = null;
    constructor() {
      channelInstances.push(this);
    }
  }
  return {
    Channel: FakeChannel,
    invoke: (...args: unknown[]) => {
      invokeMock(...args);
      // Default: pretend spawn returns a handle.
      if (args[0] === 'process_spawn') {
        return Promise.resolve({
          id: 'proc-trylo-1',
          pid: 1234,
          label: 'trylo-core',
          command: 'node index.js',
        });
      }
      if (args[0] === 'process_list') {
        return Promise.resolve([{ id: 'proc-trylo-1', label: 'trylo-core' }]);
      }
      return Promise.resolve(undefined);
    },
  };
});

// Import after the mock so the service binds to the mocked module.
import { tauriProcessService } from './tauri-process-service';

afterEach(() => {
  vi.useRealTimers();
  invokeMock.mockClear();
  channelInstances.length = 0;
});

describe('TauriProcessService', () => {
  it('passes frozen team recovery identity without putting prompt or environment in it', async () => {
    await tauriProcessService.spawn({ command: 'node', args: [], label: 'team',
      recoveryIdentity: { teamRunId: 'team-a', turnId: 'turn-a' }, onOutput() {} });
    expect(invokeMock).toHaveBeenCalledWith('process_spawn', expect.objectContaining({
      recoveryIdentity: { teamRunId: 'team-a', turnId: 'turn-a' },
    }));
  });
  it('does not wait when native incomplete output has no counted stderr pending', async () => {
    const onExit = vi.fn();
    await tauriProcessService.spawn({ command: 'node', args: [], label: 'test', onOutput() {}, onStderr() {}, onExit });
    channelInstances[0]!.onmessage!('##TRYLO_PROC_EXIT##' + JSON.stringify({ id: 'proc-trylo-1', pid: 1234,
      code: 41, signal: null, outputComplete: false, stderrLines: 0 }));
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ code: 41, outputComplete: false }));
  });

  it('still receives counted stderr when a different stream was marked incomplete', async () => {
    const onExit = vi.fn(); const onStderr = vi.fn();
    await tauriProcessService.spawn({ command: 'node', args: [], label: 'test', onOutput() {}, onStderr, onExit });
    channelInstances[0]!.onmessage!('##TRYLO_PROC_EXIT##' + JSON.stringify({ id: 'proc-trylo-1', pid: 1234,
      code: 41, signal: null, outputComplete: false, stderrLines: 1 }));
    try { expect(onExit).not.toHaveBeenCalled(); }
    finally { channelInstances[1]!.onmessage!('known queued root cause'); }
    expect(onStderr).toHaveBeenCalledWith('known queued root cause');
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ outputComplete: false }));
  });

  it('delivers an exit immediately when its counted stderr has already arrived', async () => {
    const onExit = vi.fn();
    await tauriProcessService.spawn({ command: 'node', args: [], label: 'test', onOutput() {}, onStderr() {}, onExit });
    channelInstances[1]!.onmessage!('first'); channelInstances[1]!.onmessage!('second');
    channelInstances[0]!.onmessage!('##TRYLO_PROC_EXIT##' + JSON.stringify({ id: 'proc-trylo-1', pid: 1234,
      code: 41, signal: null, outputComplete: true, stderrLines: 2 }));
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ outputComplete: true }));
  });

  it('delivers counted stderr before an exit arriving on the other native channel', async () => {
    const order: string[] = [];
    const onExit = vi.fn(() => { order.push('exit'); });
    await tauriProcessService.spawn({ command: 'node', args: [], label: 'test', onOutput() {},
      onStderr: () => { order.push('stderr'); }, onExit });
    channelInstances[0]!.onmessage!('##TRYLO_PROC_EXIT##' + JSON.stringify({ id: 'proc-trylo-1', pid: 1234,
      code: 41, signal: null, outputComplete: true, stderrLines: 1 }));
    try { expect(onExit).not.toHaveBeenCalled(); }
    finally { channelInstances[1]!.onmessage!('actual stderr cause'); }
    expect(order).toEqual(['stderr', 'exit']);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('bounds missing stderr delivery without losing the actual exit fact', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    await tauriProcessService.spawn({ command: 'node', args: [], label: 'test', onOutput() {}, onStderr() {}, onExit });
    channelInstances[0]!.onmessage!('##TRYLO_PROC_EXIT##' + JSON.stringify({ id: 'proc-trylo-1', pid: 1234,
      code: 0, signal: null, outputComplete: true, stderrLines: 1 }));
    try {
      expect(onExit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ code: 0, outputComplete: false }));
      channelInstances[1]!.onmessage!('late stderr');
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally { await vi.runOnlyPendingTimersAsync(); }
  });

  it('emits a repeated native exit frame only once', async () => {
    const onExit = vi.fn();
    await tauriProcessService.spawn({ command: 'node', args: [], label: 'test', onOutput() {}, onExit });
    const frame = '##TRYLO_PROC_EXIT##' + JSON.stringify({ id: 'proc-trylo-1', pid: 1234, code: 0, signal: null });
    channelInstances[0]!.onmessage!(frame); channelInstances[0]!.onmessage!(frame);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 'one', null])('refuses invalid stderr delivery count %s', async stderrLines => {
    const onExit = vi.fn();
    await tauriProcessService.spawn({ command: 'node', args: [], label: 'test', onOutput() {}, onExit });
    channelInstances[0]!.onmessage!('##TRYLO_PROC_EXIT##' + JSON.stringify({ id: 'proc-trylo-1', pid: 1234,
      code: 0, signal: null, outputComplete: true, stderrLines }));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('spawn forwards command/args/label/cwd and wires the channel', async () => {
    const onOutput = vi.fn();
    const handle = await tauriProcessService.spawn({
      command: 'node',
      args: ['index.js'],
      label: 'trylo-core',
      cwd: 'C:/work/demo-ws/runtime/trylo-core',
      onOutput,
    });
    expect(handle.id).toBe('proc-trylo-1');
    expect(handle.pid).toBe(1234);
    expect(invokeMock).toHaveBeenCalledWith(
      'process_spawn',
      expect.objectContaining({
        command: 'node',
        args: ['index.js'],
        label: 'trylo-core',
        cwd: 'C:/work/demo-ws/runtime/trylo-core',
      }),
    );
    // The Channel instance was created; we can simulate a stdout line.
    const ch = channelInstances[0]!;
    // Rust declares Channel<String>, so Tauri delivers
    // the stdout line itself (not an object wrapper).
    ch.onmessage!('hello');
    expect(onOutput).toHaveBeenCalledWith('hello');
  });

  it('send forwards to process_send with the id and message', async () => {
    await tauriProcessService.send('proc-trylo-1', 'hello');
    expect(invokeMock).toHaveBeenCalledWith('process_send', {
      id: 'proc-trylo-1',
      message: 'hello',
    });
  });

  it('stop forwards to process_stop with the id', async () => {
    await tauriProcessService.stop('proc-trylo-1');
    expect(invokeMock).toHaveBeenCalledWith('process_stop', {
      id: 'proc-trylo-1',
    });
  });

  it('list forwards to process_list and shapes the response', async () => {
    const list = await tauriProcessService.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('proc-trylo-1');
    expect(list[0]?.label).toBe('trylo-core');
  });

  // ── P08 §4.2: one-shot stdin EOF + separate stderr ──────────────

  it('closeInput forwards to process_close_input with the id', async () => {
    await tauriProcessService.closeInput('proc-trylo-1');
    expect(invokeMock).toHaveBeenCalledWith('process_close_input', {
      id: 'proc-trylo-1',
    });
  });

  it('closeInput does NOT stop the process', async () => {
    // The whole point of closeInput over stop: the child keeps running.
    await tauriProcessService.closeInput('proc-trylo-1');
    expect(invokeMock).not.toHaveBeenCalledWith('process_stop', expect.anything());
  });

  it('spawn without onStderr leaves stderr uncaptured (legacy unchanged)', async () => {
    await tauriProcessService.spawn({
      command: 'node',
      args: ['index.js'],
      label: 'trylo-cli',
      onOutput: vi.fn(),
    });
    const payload = invokeMock.mock.calls.find((c) => c[0] === 'process_spawn')?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(payload).toBeDefined();
    // The channel object is always allocated (Tauri cannot take an
    // optional Channel), but the capture flag is what decides whether
    // the child's stderr is piped at all. Legacy ⇒ no pipe ⇒ no flood.
    expect(payload!['captureStderr']).toBe(false);
  });

  it('spawn with onStderr asks Rust to capture and routes it separately', async () => {
    const onOutput = vi.fn();
    const onStderr = vi.fn();
    await tauriProcessService.spawn({
      command: 'node',
      args: ['index.js'],
      label: 'trylo-v1',
      onOutput,
      onStderr,
    });
    const payload = invokeMock.mock.calls.find((c) => c[0] === 'process_spawn')?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(payload!['captureStderr']).toBe(true);
    // Two channels: [0] = stdout, [1] = stderr.
    expect(channelInstances).toHaveLength(2);
    const [stdoutCh, stderrCh] = channelInstances as [
      { onmessage: ((msg: unknown) => void) | null },
      { onmessage: ((msg: unknown) => void) | null },
    ];
    stderrCh.onmessage!('cannot resume session x: missing_session');
    expect(onStderr).toHaveBeenCalledWith('cannot resume session x: missing_session');
    // A pre-run failure is real evidence; it must not be mistaken for an
    // event line on the stdout stream.
    expect(onOutput).not.toHaveBeenCalled();

    // And a stdout line still goes to stdout only.
    stdoutCh.onmessage!('{"type":"run_start"}');
    expect(onOutput).toHaveBeenCalledWith('{"type":"run_start"}');
    expect(onStderr).toHaveBeenCalledTimes(1);
  });
});
