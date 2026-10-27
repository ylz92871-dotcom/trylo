import { afterEach, expect, it, vi } from 'vitest';
import type { LiveProcessInfo, ProcessService, RecoverableProcess, RetainedProcessOutput } from '../host-adapter/process-service';
import { closeSubagentInputProcess } from '../host-adapter/trylo-v1-subagent-control';
import { ConversationRunSupervisor } from './conversation-run-supervisor';
import { applyTeamEvents } from '../surfaces/team/team-projection';
import { createFrozenTeamRun } from '../user-learning/team-access/profiles/launch';
import type { TeamProfile } from '../surfaces/team/team-profile-types';
import type { TeamRun } from '../surfaces/team/team-types';

const port = vi.hoisted(() => ({ spawn: vi.fn(), send: vi.fn(), closeInput: vi.fn(), stop: vi.fn(),
  list: vi.fn<[], Promise<readonly LiveProcessInfo[]>>(), recoveryList: vi.fn<[], Promise<readonly RecoverableProcess[]>>(),
  readOutput: vi.fn<[string, number], Promise<RetainedProcessOutput>>() } satisfies ProcessService));
vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: port } }));
const owner: RecoverableProcess = { id: 'retained-stop-root', pid: 123, projectKey: 'workspace', conversationId: 'chat',
  identity: { teamRunId: 'team', turnId: 'turn' } };
const profile: TeamProfile = { schemaVersion: 1, id: 'p', origin: 'builtin', surface: 'code', title: 'test', createdAt: 1, updatedAt: 1,
  members: [{ memberId: 'person', baseRole: 'person', displayName: 'Person',
    overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } }] };

afterEach(() => { vi.resetAllMocks(); closeSubagentInputProcess(owner.id); });

it('projects the original retained completion before Stop resolves and preserves it against the UI cancellation fallback', async () => {
  let live = true;
  const page: RetainedProcessOutput = { version: 1, process: owner, records: [], nextSequence: 0, hasMore: false,
    gap: false, captureComplete: true, finished: false, exit: null, answeredRequests: [] };
  port.list.mockImplementation(async () => live ? [{ id: owner.id, pid: owner.pid, command: 'isolated', label: 'trylo-cli-v1',
    metadata: { projectKey: owner.projectKey, conversationId: owner.conversationId } }] : []);
  port.stop.mockImplementation(async () => { live = false; });
  port.recoveryList.mockResolvedValue([owner]);
  port.readOutput.mockResolvedValueOnce(page).mockResolvedValue({ ...page, finished: true, nextSequence: 1,
    exit: { id: owner.id, pid: owner.pid, code: 0, signal: null }, records: [{ sequence: 1, stream: 'stdout', line: JSON.stringify({
      type: 'run_result', status: 'completed', finishReason: 'stop', sessionId: 'session', turnId: 'turn', iterations: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 1, lastMessage: 'natural completion',
    }) }] });
  const supervisor = new ConversationRunSupervisor();
  (await supervisor.recoverTeamOutput('workspace', 'chat', 'team'))?.acknowledge();
  const initial = createFrozenTeamRun({ teamRunId: 'team', personConversationId: 'chat', goal: 'verify', frozenProfile: profile, now: 1 });
  let projected: TeamRun = { ...initial, workspaceId: 'workspace', frozenProfile: profile, selectedSeatId: null,
    seats: initial.seats.map(seat => ({ ...seat, seat: 'person', status: 'completed', endedAt: 2 })) };
  const context = { workspaceId: 'workspace', personConversationId: 'chat', teamRunId: 'team' };
  const order: string[] = [];
  await supervisor.stopConversation('workspace', 'chat', recovery => {
    expect(recovery.process.identity.teamRunId).toBe('team');
    expect(recovery.live).toBe(false);
    projected = applyTeamEvents(projected, recovery.events, context) ?? projected;
    recovery.acknowledge(); order.push('projected');
  });
  order.push('stop-resolved');
  projected = applyTeamEvents(projected, [{ type: 'loop_end', reason: 'cancelled', ts: 20 }], context) ?? projected;
  expect(order).toEqual(['projected', 'stop-resolved']);
  expect(projected).toMatchObject({ status: 'completed', lifecycle: 'closed' });
  expect(supervisor.hasRecoveredOwner('workspace', 'chat')).toBe(false);
  expect((await supervisor.recoverTeamOutput('workspace', 'chat', 'team'))?.events).toEqual([]);
  expect(port.spawn).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
});
