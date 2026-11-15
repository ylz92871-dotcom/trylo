import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCliCommand } from './cli-command';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessHandle, ProcessService } from './process-service';
import type { FilePath, ProcessId } from './types';
import { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor';
import { approveToolAcquisition } from '../tool-learning/cli-acquisition';
import { acquisitionFixture } from '../tool-learning/acquisition-test-support';

afterEach(() => { vi.useRealTimers(); });

it('the original owner retains a real child before its delayed handle, blocks a second mutation across remount, and transfers recovery to that exact late handle', async () => {
  let release!: () => void, ready!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
  class DelayedProcess extends NodeProcessFixture {
    refuseStop = true;
    override async spawn(options: Parameters<ProcessService['spawn']>[0]): Promise<ProcessHandle> {
      const child = await super.spawn(options); ready(); await pending; return child;
    }
    override async send(_id: ProcessId, _message: string): Promise<void> { throw new Error('TEST ONLY no graceful pipe'); }
    override async stop(id: ProcessId): Promise<void> {
      if (this.refuseStop) throw new Error('TEST ONLY stop refused');
      return super.stop(id);
    }
    override async dispose(): Promise<void> { await Promise.all([...this.children.keys()].map(id => super.stop(id))); }
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'trylo-library-pending-')), script = path.join(directory, 'child.js');
  writeFileSync(script, 'process.stdin.resume();setInterval(()=>{},1000);\n');
  const service = new DelayedProcess(process.env), supervisor = new ConversationRunSupervisor(), cancel = new AbortController();
  const scope = { projectKey: directory, conversationId: 'library-pending', projectRoot: directory };
  const owner = supervisor.libraryApprovalPort(scope), recovery = supervisor.libraryRecoveryPort();
  const runtime = { process: service, cliPath: script as FilePath, nodeProgram: process.execPath, cwd: directory as FilePath, lifecycle: owner, recovery,
    // 假时钟只推进到刚过旧窗口的位置；这里固定等待时长，测的仍是"收不了尾就硬杀"。
    cancelGraceMs: 1500 };
  try {
    const first = approveToolAcquisition(runtime, acquisitionFixture(), cancel.signal);
    await started; expect(service.children.size).toBe(1); expect(owner.canStart?.()).toBe(false);
    vi.useFakeTimers(); cancel.abort();
    expect(recovery.statuses()[0]?.state).toBe('stopping');
    await vi.advanceTimersByTimeAsync(5001);
    expect(await first).toEqual({ ok: false, reason: 'stop_unconfirmed' });
    const pendingId = recovery.statuses()[0]?.processId; expect(pendingId).toBeTruthy(); expect(recovery.statuses()[0]?.state).toBe('stop_unconfirmed');
    const remounted = supervisor.libraryApprovalPort(scope);
    expect(await approveToolAcquisition({ ...runtime, lifecycle: remounted }, acquisitionFixture(), new AbortController().signal))
      .toEqual({ ok: false, reason: 'stop_unconfirmed' });
    expect(service.argv).toHaveLength(1);
    release(); await vi.advanceTimersByTimeAsync(1600);
    const handleId = [...service.children.keys()][0]!;
    expect(recovery.statuses()).toEqual([expect.objectContaining({ processId: handleId, state: 'stop_unconfirmed' })]);
    expect(handleId).not.toBe(pendingId); expect(remounted.canStart?.()).toBe(false);
    service.refuseStop = false;
    const stopped = recovery.retry(handleId); await vi.advanceTimersByTimeAsync(1600); await stopped;
    expect(service.children.size).toBe(0); expect(service.forceStops).toEqual([handleId]);
    expect(recovery.statuses()).toEqual([]); expect(remounted.canStart?.()).toBe(true);
  } finally {
    release(); vi.useRealTimers(); await service.dispose();
    expect(path.dirname(path.resolve(script))).toBe(path.resolve(directory)); rmSync(directory, { recursive: true, force: true });
  }
});

it('actual exit before handle delivery releases only its pending reservation and late attachment cannot resurrect it', async () => {
  const supervisor = new ConversationRunSupervisor(), scope = { projectKey: 'test', conversationId: 'library' };
  const lifecycle = supervisor.libraryApprovalPort(scope), recovery = supervisor.libraryRecoveryPort();
  let exit!: () => void, release!: (handle: ProcessHandle) => void;
  const process: Pick<ProcessService, 'spawn' | 'stop'> = { spawn: options => {
    exit = () => options.onExit?.({ id: 'early-exit', pid: 1, signal: null, code: 0 });
    return new Promise(resolve => { release = resolve; });
  }, stop: vi.fn(async () => {}) };
  const result = runCliCommand({ process, cliPath: 'D:/fixture/main.js' as FilePath, cwd: 'D:/fixture' as FilePath,
    args: ['tools', 'status'], lifecycle });
  expect(lifecycle.canStart?.()).toBe(false); exit(); expect(await result).toEqual({ ok: true, stdout: '' });
  expect(lifecycle.canStart?.()).toBe(true);
  release({ id: 'early-exit', pid: 1, label: 'TEST ONLY', command: 'node' }); await Promise.resolve(); await Promise.resolve();
  expect(recovery.statuses()).toEqual([]); expect(lifecycle.canStart?.()).toBe(true); expect(process.stop).not.toHaveBeenCalled();
});
