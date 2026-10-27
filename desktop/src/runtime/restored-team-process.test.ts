import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NodeProcessFixture } from '../host-adapter/cli-node-process.fixture';
import type { ProcessService } from '../host-adapter/process-service';
import { configureTeamRunsCache, loadTeamRunsForWorkspace, teamRunsSnapshot, upsertTeamRun } from '../user-learning/team-access/profiles/team-runs-cache';
import { createFrozenTeamRun } from '../user-learning/team-access/profiles/launch';
import { FIXTURE_FROZEN_PROFILE } from '../surfaces/team/team-fixture';
import { restoreTeamHistory } from './restored-team-history';
import { watchRestoredTeamHistory } from './watch-restored-team-history';
import type { TeamRun } from '../surfaces/team/team-types';

const holder = vi.hoisted(() => ({ process: null as ProcessService | null }));
vi.mock('../host-adapter/index', () => ({ hostAdapter: { get process() { return holder.process; } } }));
const { ConversationRunSupervisor } = await import('./conversation-run-supervisor');
let processPort: NodeProcessFixture;
beforeEach(async () => {
  processPort = new NodeProcessFixture(process.env); holder.process = processPort;
  configureTeamRunsCache({ readFile: async () => { throw new Error('missing'); }, writeFile: async () => {} });
  await loadTeamRunsForWorkspace('D:/real-reload', 'workspace');
  await upsertTeamRun(createFrozenTeamRun({ teamRunId: 'restored-team', personConversationId: 'chat', goal: 'preserve old work',
    frozenProfile: FIXTURE_FROZEN_PROFILE, now: 1 }));
});
afterEach(async () => { vi.restoreAllMocks(); await processPort.dispose(); });
const spawn = (conversationId = 'chat') => processPort.spawn({ command: process.execPath,
  args: ['-e', '/* team-history-recovery-20261026 */ setInterval(()=>{},1000)'], label: 'trylo-cli-v1',
  metadata: { projectKey: 'D:/real-reload', conversationId, runId: 'old-native-run' }, onOutput() {} });
const recover = (runtime: InstanceType<typeof ConversationRunSupervisor>) => restoreTeamHistory({
  workspaceRoot: 'D:/real-reload', workspaceId: 'workspace', conversationId: 'chat', runtime, now: () => 10 });

it('a reconstructed supervisor detects a real old root, blocks new send, and stops it before history can close', async () => {
  const old = await spawn(); const sibling = await spawn('other-chat');
  const runtime = new ConversationRunSupervisor();
  expect(await recover(runtime)).toMatchObject({ lifecycle: 'open', recovery: { kind: 'detached' } });
  expect(processPort.children.has(old.id)).toBe(true); expect(runtime.beginSend('D:/real-reload', 'chat')).toBeNull();
  await runtime.stopConversation('D:/real-reload', 'chat');
  expect(processPort.children.has(old.id)).toBe(false); expect(processPort.children.has(sibling.id)).toBe(true);
  expect(await recover(runtime)).toMatchObject({ lifecycle: 'closed', status: 'failed' });
}, 15000);

it('a genuinely exited root permits interruption classification without dispatching or replaying any work', async () => {
  const old = await spawn(); await processPort.stop(old.id);
  const spawnAgain = vi.spyOn(processPort, 'spawn');
  expect(await recover(new ConversationRunSupervisor())).toMatchObject({ lifecycle: 'closed', error: expect.stringContaining('中断') });
  expect(spawnAgain).not.toHaveBeenCalled(); expect(teamRunsSnapshot('workspace')[0]?.status).toBe('failed');
}, 15000);

it('pending local preparation is not mistaken for a root that disappeared before spawn', async () => {
  const runtime = new ConversationRunSupervisor(); const ticket = runtime.beginSend('D:/real-reload', 'chat');
  const list = vi.spyOn(processPort, 'list');
  expect(await recover(runtime)).toMatchObject({ lifecycle: 'open' }); expect(list).not.toHaveBeenCalled();
  ticket?.cancel();
});

it('a refused detached stop remains retryable without rewriting the team as interrupted', async () => {
  const old = await spawn(); const realStop = processPort.stop.bind(processPort);
  const stop = vi.spyOn(processPort, 'stop').mockRejectedValueOnce(new Error('native stop refused'));
  const runtime = new ConversationRunSupervisor(); await recover(runtime);
  await expect(runtime.stopConversation('D:/real-reload', 'chat')).rejects.toThrow('native stop refused');
  expect(processPort.children.has(old.id)).toBe(true); expect(teamRunsSnapshot('workspace')[0]?.lifecycle).toBe('open');
  stop.mockImplementation(realStop); await runtime.stopConversation('D:/real-reload', 'chat');
  expect(processPort.children.has(old.id)).toBe(false);
}, 15000);

it('an observed detached real root closes automatically after its independent exit while another root survives', async () => {
  const old = await spawn(); const sibling = await spawn('other-chat');
  const runtime = new ConversationRunSupervisor();
  let seen!: () => void; let ended!: (run: TeamRun) => void;
  const detached = new Promise<void>(resolve => { seen = resolve; });
  const closed = new Promise<TeamRun>(resolve => { ended = resolve; });
  const errors: unknown[] = [];
  const spawnAgain = vi.spyOn(processPort, 'spawn');
  const stopWatching = watchRestoredTeamHistory({ workspaceRoot: 'D:/real-reload', workspaceId: 'workspace',
    conversationId: 'chat', runtime, now: () => 10,
    onRestored: run => { if (run?.recovery?.kind === 'detached') seen(); if (run?.lifecycle === 'closed') ended(run); },
    onError: error => errors.push(error) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await detached;
    await processPort.stop(old.id); // Independent child exit, not a supervisor/observer Stop.
    const restored = await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Detached observer never rechecked the exited root.')), 2500);
    })]);
    expect(restored).toMatchObject({ lifecycle: 'closed', status: 'failed' });
    expect(processPort.children.has(sibling.id)).toBe(true);
    expect(spawnAgain).not.toHaveBeenCalled(); expect(errors).toEqual([]);
    const ticket = runtime.beginSend('D:/real-reload', 'chat'); expect(ticket).not.toBeNull(); ticket?.cancel();
  } finally { clearTimeout(timer); stopWatching(); }
}, 15000);
