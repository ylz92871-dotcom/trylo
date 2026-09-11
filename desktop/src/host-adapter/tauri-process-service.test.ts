// Trylo Desktop — TauriProcessService unit tests. See
// the architecture doc §2.2 + §3 Phase 2 task #3+#4.
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
  invokeMock.mockClear();
  channelInstances.length = 0;
});

describe('TauriProcessService', () => {
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
});
