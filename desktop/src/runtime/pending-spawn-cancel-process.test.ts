import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessFixture } from '../host-adapter/cli-node-process.fixture';
import type { ProcessService } from '../host-adapter/process-service';
import type { FilePath, ProcessId } from '../host-adapter/types';
import type { LoopEvent } from '../host-adapter/loop-events';
import { settingsDefaults } from '../settings/settings-store';
import { routeTeamEvents } from './team-event-routing';
import { configureTeamRunsCache, loadTeamRunsForWorkspace, teamRunsSnapshot, upsertTeamRun } from '../user-learning/team-access/profiles/team-runs-cache';
import { createFrozenTeamRun } from '../user-learning/team-access/profiles/launch';
import type { TeamProfile } from '../surfaces/team/team-profile-types';

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

it.each(['confirmed', 'refused', 'spawn-rejected'] as const)(
  'retains cancellation ownership before a real native spawn response: %s', async mode => {
    let ready!: () => void; let release!: () => void;
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    class DelayedSpawnProcess extends NodeProcessFixture {
      refuseStop = mode === 'refused';
      readonly input: string[] = [];
      override async spawn(opts: Parameters<ProcessService['spawn']>[0]) {
        if (mode === 'spawn-rejected') { ready(); await pending; throw new Error('native spawn rejected'); }
        const handle = await super.spawn(opts); ready(); await pending; return handle;
      }
      override async send(id: ProcessId, message: string) {
        this.input.push(message);
        if (JSON.parse(message).request?.subtype === 'interrupt') throw new Error('control pipe unavailable');
        return super.send(id, message);
      }
      override async stop(id: ProcessId) {
        if (this.refuseStop) throw new Error('native cancellation cleanup refused');
        return super.stop(id);
      }
      override async dispose() { await Promise.all([...this.children.keys()].map(id => super.stop(id))); }
    }
    const service = new DelayedSpawnProcess(process.env); services.push(service); holder.process = service;
    const directory = mkdtempSync(join(tmpdir(), 'trylo-pending-spawn-cancel-'));
    const script = join(directory, 'pending-spawn.js'); scripts.push(script);
    writeFileSync(script, 'process.stdin.resume();setInterval(()=>{},1000);\n');
    const savedTeams = new Map<string, string>();
    configureTeamRunsCache({ readFile: async () => { throw new Error('missing fixture history'); },
      writeFile: async (path, text) => { savedTeams.set(path, text); } });
    const profile: TeamProfile = { schemaVersion: 1, id: 'cancel-profile', origin: 'custom', surface: 'code', title: 'Cancel proof',
      createdAt: 1, updatedAt: 1, members: ['person', 'worker'].map((role, index) => ({ memberId: `m${index}`,
        baseRole: role as 'person' | 'worker', displayName: role,
        overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } })) };
    await loadTeamRunsForWorkspace(directory, directory);
    const team = createFrozenTeamRun({ teamRunId: `team-${mode}`, personConversationId: mode, goal: 'cancel proof', frozenProfile: profile, now: 1 });
    await upsertTeamRun({ ...team, seats: team.seats.map(seat => seat.memberId === 'm0'
      ? { ...seat, status: 'completed', summary: 'preserved prior result' } : { ...seat, status: 'waiting_approval' }) });
    const controller = new CodeRunController({ projectKey: directory, conversationId: mode, onChange() {},
      permissions: new CodePermissionRegistry({ onChange() {}, send: async () => true }) });
    const events: LoopEvent[] = [];
    const request = { prompt: 'must not be delivered', turnId: `turn-${mode}`, teamMode: true,
      settings: { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1' as const, cliPath: script as FilePath,
        cliNodeProgram: process.execPath, cwd: directory as FilePath, apiFormat: 'openai' as const,
        apiKey: 'local-test-only', apiModel: 'unused', apiHost: 'http://127.0.0.1:9' },
      priorMessages: [], permissionLevel: 'read_only' as const, codeMode: 'agent' as const,
      onEvents: (batch: readonly LoopEvent[]) => {
        events.push(...batch);
        routeTeamEvents({ workspaceId: directory, personConversationId: mode, teamRunId: team.id }, batch);
      } };
    const starting = controller.run(request);
    const settled = starting.then(() => ({ kind: 'resolved' as const }), error => ({ kind: 'rejected' as const, error }));
    try {
      await acquired;
      await loadTeamRunsForWorkspace(`${directory}/other`, `${directory}/other`);
      await upsertTeamRun(createFrozenTeamRun({ teamRunId: 'other-team', personConversationId: 'other-chat', goal: 'unrelated', frozenProfile: profile, now: 1 }));
      expect(controller.getViewState().activeProcessId).toBeNull();
      await expect(controller.stop()).rejects.toThrow(/启动|spawn/i);
      expect(controller.getViewState()).toMatchObject({ running: true, sendable: false });
      expect(events.some(event => event.type === 'loop_end')).toBe(false);
      expect(controller.ownsNativeTurn(request.turnId)).toBe(true);
      await expect(controller.run({ ...request, prompt: 'must not dispatch another root' })).rejects.toThrow(/stop|停止|启动/i);
      expect(service.children.size).toBe(mode === 'spawn-rejected' ? 0 : 1);
      release(); const result = await settled;
      if (mode === 'refused') {
        expect(result.kind).toBe('rejected');
        const [id] = service.children.keys();
        expect(controller.getViewState()).toMatchObject({ activeProcessId: id, running: true, sendable: false, error: true });
        expect(events.some(event => event.type === 'loop_end')).toBe(false);
        service.refuseStop = false;
        await controller.stop();
      }
      expect(service.input.some(message => JSON.parse(message).type === 'user')).toBe(false);
      expect(service.children.size).toBe(0);
      expect(await service.list()).toEqual([]);
      expect(controller.getViewState()).toMatchObject({ activeProcessId: null, running: false, sendable: true, error: false });
      expect(controller.ownsNativeTurn(request.turnId)).toBe(false);
      expect(events.filter(event => event.type === 'loop_end')).toMatchObject([{ reason: 'cancelled' }]);
      const projected = teamRunsSnapshot(directory)[0]!;
      expect(projected).toMatchObject({ lifecycle: 'closed', status: 'cancelled' });
      expect(projected.seats.find(seat => seat.memberId === 'm0')).toMatchObject({ status: 'completed', summary: 'preserved prior result' });
      expect(projected.seats.find(seat => seat.memberId === 'm1')?.status).toBe('cancelled');
      expect(teamRunsSnapshot()[0]).toMatchObject({ id: 'other-team', lifecycle: 'open' });
      await upsertTeamRun(projected, directory); // Flush the origin cache's queued persistence.
      const persisted = JSON.parse(savedTeams.get(`${directory.replaceAll('\\', '/')}/.trylo/team-runs.json`)!);
      expect(persisted.runs[0]).toMatchObject({ id: team.id, lifecycle: 'closed', status: 'cancelled' });
    } finally { release(); service.refuseStop = false; await settled; await service.dispose(); }
  }, 12_000,
);
