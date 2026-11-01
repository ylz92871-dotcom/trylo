import { expect, it } from 'vitest';
import { runCliCommand } from './cli-command';
import type { ProcessService, ProcessHandle } from './process-service';
import type { FilePath } from './types';

const paths = { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath };
it('a cancelled query waits for a late spawn handle and stops only that child once', async () => {
  const stops: string[] = []; let release!: (child: ProcessHandle) => void;
  const process: Pick<ProcessService, 'spawn' | 'stop'> = { spawn: () => new Promise(resolve => { release = resolve; }), stop: async id => { stops.push(id); } };
  const controller = new AbortController();
  const result = runCliCommand({ ...paths, process, args: ['tools', 'status', '--json'], signal: controller.signal }); controller.abort();
  expect(await result).toEqual({ ok: false, reason: 'cancelled' });
  release({ id: 'owned', pid: 1, label: 'status', command: 'node' }); await Promise.resolve(); await Promise.resolve();
  expect(stops).toEqual(['owned']);
});
it('oversized synchronous output fails and closes the child after its handle arrives', async () => {
  const stops: string[] = [];
  const process: Pick<ProcessService, 'spawn' | 'stop'> = { async spawn(options) {
    options.onOutput('x'.repeat(1_048_577)); return { id: 'owned', pid: 1, label: options.label, command: options.command };
  }, stop: async id => { stops.push(id); } };
  expect(await runCliCommand({ ...paths, process, args: ['tools', 'status'] })).toEqual({ ok: false, reason: 'output_limit' });
  await Promise.resolve(); expect(stops).toEqual(['owned']);
});
it('pre-cancelled queries never spawn and synchronous spawn exceptions remain typed', async () => {
  let calls = 0;
  const process: Pick<ProcessService, 'spawn' | 'stop'> = { spawn: () => { calls++; throw new Error('test'); }, stop: async () => {} };
  const controller = new AbortController(); controller.abort();
  expect(await runCliCommand({ ...paths, process, args: [], signal: controller.signal })).toEqual({ ok: false, reason: 'cancelled' });
  expect(calls).toBe(0);
  expect(await runCliCommand({ ...paths, process, args: [] })).toEqual({ ok: false, reason: 'spawn_failed' });
});
