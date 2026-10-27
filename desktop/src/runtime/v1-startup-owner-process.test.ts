import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessFixture } from '../host-adapter/cli-node-process.fixture';
import type { ProcessService } from '../host-adapter/process-service';
import type { FilePath, ProcessId } from '../host-adapter/types';
import type { LoopEvent } from '../host-adapter/loop-events';
import { settingsDefaults } from '../settings/settings-store';

const holder = vi.hoisted(() => ({ process: null as ProcessService | null }));
vi.mock('../host-adapter/index', () => ({ hostAdapter: { get process() { return holder.process; } } }));
vi.mock('./cli-runtime-guard', () => ({ verifyCliRuntime: vi.fn(async () => ({ ok: true })) }));
const { CodeRunController } = await import('./code-run-controller');
const { CodePermissionRegistry } = await import('./code-permission-registry');
const services: NodeProcessFixture[] = [];
const scripts: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  for (const script of scripts.splice(0)) { unlinkSync(script); rmdirSync(join(script, '..')); }
});

it.each(['stop-during-write', 'exit-during-write', 'failed-cleanup-retry'] as const)(
  'retains the exact real child through %s', async mode => {
    let writing!: () => void;
    const writeStarted = new Promise<void>(resolve => { writing = resolve; });
    const never = new Promise<void>(() => {});
    class StartupProcess extends NodeProcessFixture {
      private refuseStop = mode === 'failed-cleanup-retry';
      override async send(id: ProcessId, message: string) {
        if (JSON.parse(message).type === 'user') {
          writing();
          if (mode === 'failed-cleanup-retry') throw new Error('initial write refused');
          await super.send(id, message);
          return never;
        }
        return super.send(id, message);
      }
      override async stop(id: ProcessId) {
        if (this.refuseStop) { this.refuseStop = false; throw new Error('first native stop refused'); }
        await super.stop(id);
      }
      override async dispose() {
        // Cleanup always reaches the real child, independently of injected receipts.
        for (const id of this.children.keys()) await super.stop(id);
      }
    }
    const service = new StartupProcess(process.env); services.push(service); holder.process = service;
    const directory = mkdtempSync(join(tmpdir(), 'trylo-v1-startup-owner-'));
    const script = join(directory, 'startup-owner.js'); scripts.push(script);
    writeFileSync(script, mode === 'exit-during-write'
      ? "process.stdin.once('data',()=>setTimeout(()=>process.exit(41),200));process.stdin.resume();\n"
      : 'process.stdin.resume();setInterval(()=>{},1000);\n');
    const controller = new CodeRunController({ projectKey: directory, conversationId: mode, onChange() {},
      permissions: new CodePermissionRegistry({ onChange() {}, send: async () => true }) });
    const events: LoopEvent[] = [];
    const request = { prompt: 'local startup lifecycle probe', turnId: `turn-${mode}`, teamMode: true,
      settings: { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1' as const, cliPath: script as FilePath,
        cliNodeProgram: process.execPath, cwd: directory as FilePath, apiFormat: 'openai' as const,
        apiKey: 'local-test-only', apiModel: 'unused', apiHost: 'http://127.0.0.1:9' },
      priorMessages: [], permissionLevel: 'read_only' as const, codeMode: 'agent' as const,
      onEvents: (batch: readonly LoopEvent[]) => events.push(...batch) };
    const starting = controller.run(request);
    // Observe the rejection now, even while waiting for the real cleanup attempt.
    const settled = starting.then(() => ({ kind: 'resolved' as const }), error => ({ kind: 'rejected' as const, error }));
    await writeStarted;
    const id = controller.getViewState().activeProcessId;
    expect(id).not.toBeNull();
    expect(controller.ownsNativeTurn(request.turnId)).toBe(true);
    if (mode === 'failed-cleanup-retry') {
      expect((await settled).kind).toBe('rejected');
      expect(controller.getViewState()).toMatchObject({ activeProcessId: id, running: true, error: true, sendable: false });
      expect((await service.list()).map(row => row.id)).toEqual([id]);
      await expect(controller.run({ ...request, prompt: 'must not replace' })).rejects.toThrow(/stop|停止/i);
      expect(events.some(event => event.type === 'runtime_warning' && event.code === 'prompt_delivery_uncertain')).toBe(true);
      await controller.stop();
    } else if (mode === 'stop-during-write') {
      await controller.stop();
    }
    await settled;
    expect(service.children.size).toBe(0);
    expect(await service.list()).toEqual([]);
    expect(controller.getViewState()).toMatchObject({ activeProcessId: null, running: false, sendable: true, bindingState: 'exited' });
    expect(controller.ownsNativeTurn(request.turnId)).toBe(false);
    expect(service.forceStops).toHaveLength(mode === 'exit-during-write' ? 0 : 1);
  }, 15_000,
);
