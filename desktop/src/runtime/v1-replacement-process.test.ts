import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessFixture } from '../host-adapter/cli-node-process.fixture';
import type { ProcessService } from '../host-adapter/process-service';
import type { FilePath, ProcessId } from '../host-adapter/types';
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

it.each(['refused', 'cancelled'] as const)('keeps one real root when replacement cleanup is %s', async mode => {
  let interrupted!: () => void;
  const interruptSent = new Promise<void>(resolve => { interrupted = resolve; });
  class ReplacementProcess extends NodeProcessFixture {
    private refuseStop = mode === 'refused';
    override async send(id: ProcessId, message: string) {
      if (JSON.parse(message).request?.subtype === 'interrupt') interrupted();
      await super.send(id, message);
    }
    override async stop(id: ProcessId) {
      if (this.refuseStop) { this.refuseStop = false; throw new Error('replacement native stop refused'); }
      await super.stop(id);
    }
    override async dispose() {
      for (const id of this.children.keys()) await super.stop(id);
    }
  }
  const service = new ReplacementProcess(process.env); services.push(service); holder.process = service;
  const directory = mkdtempSync(join(tmpdir(), 'trylo-v1-replacement-owner-'));
  const script = join(directory, 'replacement-owner.js'); scripts.push(script);
  writeFileSync(script, 'process.stdin.resume();setInterval(()=>{},1000);\n');
  const controller = new CodeRunController({ projectKey: directory, conversationId: mode, onChange() {},
    permissions: new CodePermissionRegistry({ onChange() {}, send: async () => true }) });
  const request = { prompt: 'local original turn', turnId: `original-${mode}`, teamMode: true,
    settings: { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1' as const, cliPath: script as FilePath,
      cliNodeProgram: process.execPath, cwd: directory as FilePath, apiFormat: 'openai' as const,
      apiKey: 'local-test-only', apiModel: 'unused', apiHost: 'http://127.0.0.1:9' },
    priorMessages: [], permissionLevel: 'read_only' as const, codeMode: 'agent' as const, onEvents() {} };
  await controller.run(request);
  const originalId = controller.getViewState().activeProcessId!;
  const replacement = controller.run({ ...request, prompt: 'must not dispatch a second root', turnId: `replacement-${mode}` });
  const settled = replacement.then(() => 'resolved', () => 'rejected');
  await interruptSent;
  if (mode === 'refused') {
    expect(await settled).toBe('rejected');
    expect(controller.getViewState()).toMatchObject({ activeProcessId: originalId, running: true, sendable: false, error: true });
    expect((await service.list()).map(row => row.id)).toEqual([originalId]);
    // Independent real exit must release the retained old callback generation.
    await NodeProcessFixture.prototype.stop.call(service, originalId as ProcessId);
  } else {
    await controller.stop();
    await settled;
  }
  expect(service.argv).toHaveLength(1);
  expect(service.children.size).toBe(0);
  expect(await service.list()).toEqual([]);
  expect(controller.getViewState()).toMatchObject({ activeProcessId: null, running: false, sendable: true });
}, 12_000);
