import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCliCommand } from './cli-command';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { LiveProcessInfo, ProcessService } from './process-service';
import type { FilePath, ProcessId } from './types';
import { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor';
import { createDesktopLibraryClients } from '../collaboration-learning/library-clients';
import { expertUserActionControl } from '../collaboration-learning/expert-user-action-control';

it('transfers the pending expert action to its exact native handle without duplicate retained entries', async () => {
  const supervisor = new ConversationRunSupervisor();
  const owner = supervisor.libraryApprovalPort({ projectKey: 'expert-transfer', conversationId: 'library' });
  const recovery = supervisor.libraryRecoveryPort();
  const wrapped = expertUserActionControl({ command: { operation: 'requests' }, control: owner,
    workspaceRoot: 'D:/expert-transfer', signal: new AbortController().signal }).control;
  const stop = vi.fn(async () => {}), confirmExit = vi.fn(async () => false);
  const reservation = wrapped.starting!(stop);
  wrapped.stopUnconfirmed!(reservation, 'late handle');
  wrapped.acquired!({ id: 'actual-expert', pid: 1, label: 'TEST ONLY', command: 'node' }, stop, reservation, confirmExit);
  wrapped.stopUnconfirmed!('actual-expert', 'native stop unavailable');
  expect(recovery.statuses()).toEqual([expect.objectContaining({ processId: 'actual-expert', state: 'stop_unconfirmed' })]);
  await owner.reconcile?.();expect(confirmExit).toHaveBeenCalledTimes(1);
  wrapped.exited!('actual-expert', reservation);
  expect(recovery.statuses()).toEqual([]);expect(owner.canStart?.()).toBe(true);
});

it.each(['read refresh', 'explicit stop retry'] as const)(
  '%s releases only a natively reaped library child after a lost exit callback, then loads the original library', async recoveryMode => {
    class LostExitProcess extends NodeProcessFixture {
      listMode: 'valid' | 'unavailable' | 'invalid' = 'valid';
      readonly delayedExits: (() => void)[] = [];
      readonly stopAttempts: ProcessId[] = [];
      override async spawn(options: Parameters<ProcessService['spawn']>[0]) {
        return super.spawn({ ...options, onExit: info => {
          if (options.args.includes('--hold')) this.delayedExits.push(() => options.onExit?.(info));
          else options.onExit?.(info);
        } });
      }
      override async stop(id: ProcessId): Promise<void> {
        this.stopAttempts.push(id);throw new Error('TEST ONLY unavailable stop acknowledgement');
      }
      override async send(id: ProcessId, message: string): Promise<void> {
        if (JSON.parse(message).type === 'control_request') throw new Error('TEST ONLY closed interrupt pipe');
        return super.send(id, message);
      }
      override async list(): Promise<readonly LiveProcessInfo[]> {
        if (this.listMode === 'unavailable') throw new Error('TEST ONLY native list unavailable');
        if (this.listMode === 'invalid') return [{ id: '' as ProcessId, pid: 0, label: 'invalid', command: '', metadata: {} }];
        return super.list();
      }
      reap(id: ProcessId) { return super.stop(id); }
      override async dispose() { await Promise.all([...this.children.keys()].map(id => super.stop(id))); }
    }
    const directory = mkdtempSync(path.join(tmpdir(), 'trylo-library-lost-exit-'));
    const script = path.join(directory, 'library.js');
    writeFileSync(script, "if(process.argv.includes('--hold')){process.stdin.resume();setInterval(()=>{},1000)}else{process.stdin.once('data',()=>{console.log('[]');process.exit(0)});process.stdin.resume()}\n");
    const service = new LostExitProcess(process.env), supervisor = new ConversationRunSupervisor();
    const scope = { projectKey: directory, conversationId: 'library', projectRoot: directory };
    const owner = supervisor.libraryApprovalPort(scope), recovery = supervisor.libraryRecoveryPort();
    const runtime = { process: service, cliPath: script as FilePath, cwd: directory as FilePath, nodeProgram: process.execPath,
      // 这个用例固定的是「收不了尾就硬杀并保留恢复入口」，不是等多久。
      cancelGraceMs: 1500 };
    const clients = createDesktopLibraryClients(runtime, undefined, owner);
    const cancel = new AbortController();
    const first = runCliCommand({ ...runtime, args: ['--hold'], stdin: '{}\n', lifecycle: owner, signal: cancel.signal });
    try {
      await vi.waitFor(() => expect(service.children.size).toBe(1));
      await vi.waitFor(() => expect(owner.startState?.()).toBe('ready'));
      const held = [...service.children.keys()][0]!;
      const other = await service.spawn({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
        label: 'TEST ONLY unrelated live child', onOutput() {} });
      vi.useFakeTimers();cancel.abort();await vi.advanceTimersByTimeAsync(1601);
      expect(await first).toEqual({ ok: false, reason: 'stop_unconfirmed' });
      vi.useRealTimers();
      expect(recovery.statuses()).toEqual([expect.objectContaining({ processId: held, state: 'stop_unconfirmed' })]);
      const request = () => clients.experts.requests(new AbortController().signal);
      await expect(request()).rejects.toThrow('上次库操作尚未确认停止');
      expect(service.argv).toHaveLength(2);expect(owner.canStart?.()).toBe(false);
      await service.reap(held); // Real close removes the id; callback delivery is deliberately withheld.
      expect((await service.list()).map(row => row.id)).toEqual([other.id]);
      for (const mode of ['unavailable', 'invalid'] as const) {
        service.listMode = mode;
        await expect(request()).rejects.toThrow('上次库操作尚未确认停止');
        expect(owner.canStart?.()).toBe(false);expect(service.argv).toHaveLength(2);
      }
      service.listMode = 'valid';
      if (recoveryMode === 'explicit stop retry') await recovery.retry(held);
      await expect(request()).resolves.toEqual([]);
      expect(recovery.statuses()).toEqual([]);expect(owner.canStart?.()).toBe(true);
      expect(service.stopAttempts).toEqual([held]);
      expect(service.children.has(other.id)).toBe(true);expect(service.forceStops).not.toContain(other.id);
      service.delayedExits.splice(0).forEach(deliver => deliver());
      expect(recovery.statuses()).toEqual([]);expect(await first).toEqual({ ok: false, reason: 'stop_unconfirmed' });
    } finally {
      vi.useRealTimers();await service.dispose();
      expect(service.children.size).toBe(0);
      expect(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep)).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000,
);
