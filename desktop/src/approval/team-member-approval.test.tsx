import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { parseControlFrame } from '../host-adapter/control-protocol';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';
import { ApprovalCard } from '../components/chat/ApprovalCard';
import type { ApprovalMessage } from '../components/chat/types';
import { SurfaceHost } from '../surfaces/SurfaceHost';
import { FIXTURE_TEAM_RUN } from '../surfaces/team/team-fixture';

afterEach(cleanup);
const requester = { kind: 'subagent' as const, taskId: 'task-a', executionId: 'exec-a', teamRunId: 'run-a',
  memberId: 'writer-a', displayName: '资料整理成员', role: 'worker' };

it('keeps the owner decision surface visible while viewing the running team', () => {
  render(<SurfaceHost collaborationSurface="team" teamRun={FIXTURE_TEAM_RUN} personView={<div>个人聊天</div>}
    onSelectTeamSeat={() => {}} {...{ teamApprovals: <div>待审批：report.md</div> }} />);
  expect(screen.getByText('待审批：report.md')).toBeTruthy();
  expect(screen.getByText('个人聊天')).toBeTruthy();
});

it('preserves validated member provenance through protocol and owner registry', () => {
  const frame = parseControlFrame({ type: 'control_request', request_id: 'member-approval',
    request: { subtype: 'can_use_tool', tool_name: 'write_file', input: { path: 'report.md' }, requester } });
  expect(frame).toMatchObject({ kind: 'permission', requester });
  const registry = new CodePermissionRegistry({ onChange() {}, send: async () => true });
  registry.handleControlFrame(frame!, { processId: 'owner-process', projectKey: 'project', conversationId: 'conversation' });
  expect(registry.list()[0]).toMatchObject({ requester, processId: 'owner-process', conversationId: 'conversation' });
  registry.handleControlFrame({ kind: 'cancel', requestId: 'member-approval' },
    { processId: 'sibling-process', projectKey: 'project', conversationId: 'conversation' });
  expect(registry.list()).toHaveLength(1);
  registry.handleControlFrame({ kind: 'cancel', requestId: 'member-approval' },
    { processId: 'owner-process', projectKey: 'project', conversationId: 'conversation' });
  expect(registry.list()).toHaveLength(0);
});

it('ignores malformed display provenance while keeping the owner approval request', () => {
  const frame = parseControlFrame({ type: 'control_request', request_id: 'legacy', request: {
    subtype: 'can_use_tool', tool_name: 'write_file', requester: { ...requester, executionId: 12 } } });
  expect(frame).toMatchObject({ kind: 'permission', requestId: 'legacy' });
  expect(frame).not.toHaveProperty('requester');
});

it('names the member on the approval card and routes the original owner request once', () => {
  const onRespond = vi.fn();
  const message: ApprovalMessage = { id: 'approval', kind: 'approval', role: 'system', createdAt: 1,
    authority: 'code', approvalId: 'member-approval', type: 'write_file', status: 'pending',
    description: '写入 report.md', ...{ requester } };
  render(<ApprovalCard message={message} onRespond={onRespond} />);
  expect(screen.getByLabelText('申请成员').textContent).toContain('资料整理成员');
  expect(screen.queryByText('exec-a')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '批准并继续' }));
  expect(onRespond).toHaveBeenCalledTimes(1);
  expect(onRespond).toHaveBeenCalledWith('member-approval', true);
});
