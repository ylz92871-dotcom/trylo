import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessFixture } from '../host-adapter/cli-node-process.fixture';
import type { ProcessService } from '../host-adapter/process-service';
import type { FilePath } from '../host-adapter/types';
import { settingsDefaults } from '../settings/settings-store';

const holder = vi.hoisted(() => ({ process: null as ProcessService | null }));
vi.mock('../host-adapter/index', () => ({ hostAdapter: { get process() { return holder.process; } } }));
vi.mock('./cli-runtime-guard', () => ({ verifyCliRuntime: vi.fn(async () => ({ ok: true })) }));
const { CodeRunController } = await import('./code-run-controller');
const { CodePermissionRegistry } = await import('./code-permission-registry');
const services: NodeProcessFixture[] = [];
const files: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  for (const file of files.splice(0)) { unlinkSync(file); rmdirSync(join(file, '..')); }
});

it('a real early Node exit wins over its delayed spawn acknowledgement without a late prompt or phantom owner', async () => {
  class DelayedSpawnReceipt extends NodeProcessFixture {
    override async spawn(opts: Parameters<ProcessService['spawn']>[0]) {
      const handle = await super.spawn(opts);
      await this.exits.get(handle.id);
      return handle;
    }
  }
  const service = new DelayedSpawnReceipt(process.env); services.push(service); holder.process = service;
  const directory = mkdtempSync(join(tmpdir(), 'trylo-fast-startup-exit-'));
  const script = join(directory, 'fast-exit.js'); files.push(script);
  writeFileSync(script, "process.stderr.write('FAST_STARTUP_EXIT_PROOF\\n');process.exit(41);\n");
  const send = vi.spyOn(service, 'send');
  const controller = new CodeRunController({ projectKey: directory, conversationId: 'fast-exit-chat', onChange() {},
    permissions: new CodePermissionRegistry({ onChange() {}, send: async () => true }) });
  await controller.run({ prompt: 'must never reach the exited child', turnId: 'fast-exit-turn', teamMode: true,
    settings: { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1', cliPath: script as FilePath,
      cliNodeProgram: process.execPath, cwd: directory as FilePath, apiFormat: 'openai',
      apiKey: 'local-test-only', apiModel: 'unused', apiHost: 'http://127.0.0.1:9' },
    priorMessages: [], permissionLevel: 'read_only', codeMode: 'agent', onEvents() {} });
  expect(service.children.size).toBe(0);
  expect(send).not.toHaveBeenCalled();
  expect(controller.getViewState()).toMatchObject({ activeProcessId: null, running: false, sendable: true, bindingState: 'exited' });
  expect(controller.ownsNativeTurn('fast-exit-turn')).toBe(false);
  expect(service.stderr).toContain('FAST_STARTUP_EXIT_PROOF');
}, 15000);
