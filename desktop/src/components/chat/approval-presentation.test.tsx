import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { AgentConversationSurface } from './AgentConversationSurface';
import { ConversationPresentation } from './ConversationPresentation';
import { Message } from './Message';
import { mergeCodeApprovals } from './code-approval-messages';
import { SurfaceHost } from '../../surfaces/SurfaceHost';
import { FIXTURE_TEAM_RUN } from '../../surfaces/team/team-fixture';
import { createTeamApprovalPresentation, TeamApprovalRequests } from '../../surfaces/team/run/TeamApprovalRequests';
import type { ApprovalMessage, ChatMessage } from './types';

vi.mock('react-virtuoso', async () => import('../../test-support/virtuoso'));
beforeEach(() => localStorage.setItem('trylo:team:workspace-layout:v1', JSON.stringify({ view: 'map' })));
afterEach(() => { cleanup(); localStorage.clear(); });

function request(overrides: Partial<ApprovalMessage> = {}): ApprovalMessage {
  return {
    id: 'live-row', kind: 'approval', role: 'system', createdAt: 2,
    authority: 'code', approvalId: 'request-1', status: 'pending', type: 'write_file',
    description: '写入本轮验证文件', pendingRequest: {
      requestId: 'request-1', projectKey: 'project', conversationId: 'conversation',
      processId: 'process', toolName: 'write_file', input: { path: 'report.md' },
    }, ...overrides,
  };
}

function renderHost(messages: readonly ChatMessage[], options: {
  readonly surface?: 'code' | 'work'; readonly rail?: boolean; readonly person?: boolean;
  readonly live?: readonly ChatMessage[];
} = {}) {
  const respond = vi.fn(async () => true);
  const presentation = createTeamApprovalPresentation(messages, FIXTURE_TEAM_RUN.id, options.live);
  const view = render(<SurfaceHost collaborationSurface={options.person ? 'person' : 'team'}
    teamRun={FIXTURE_TEAM_RUN} onSelectTeamSeat={() => undefined}
    hostedApprovals={presentation.hostedApprovals}
    teamApprovals={options.rail === false ? undefined : <TeamApprovalRequests
      presentation={presentation} onRespond={respond} onOpenPreview={() => undefined} />}
    personView={<AgentConversationSurface surface={options.surface ?? 'code'}
      messages={messages} running emptyState={null} composer={<textarea aria-label="输入" />}
      onRespondApproval={respond} />} />);
  return { ...view, respond };
}

describe('one approval presentation per live identity', () => {
  it('keeps a current raw live request actionable when the same ID has settled history', async () => {
    const live = request();
    const historical = request({ status: 'approved', pendingRequest: undefined });
    const messages = mergeCodeApprovals([historical], [live]);
    const view = renderHost(messages, { live: [live] });
    expect(view.getAllByRole('button', { name: '批准并继续' })).toHaveLength(1);
    const history = view.container.querySelector<HTMLElement>('.team-workspace__person .approval-card')!;
    expect(history).not.toBeNull();
    expect(within(history).getByText('已批准')).toBeTruthy();
    expect(within(history).queryByRole('button', { name: '批准并继续' })).toBeNull();
    await act(async () => fireEvent.click(view.getByRole('button', { name: '批准并继续' })));
    expect(view.respond).toHaveBeenCalledWith('request-1', true);
  });

  it.each(['processId', 'projectKey', 'conversationId', 'toolName'] as const)('does not borrow a stable row ID from a different live %s', field => {
    const live = request();
    const other = request({ id: 'other-handle-row', pendingRequest: { ...live.pendingRequest!, [field]: 'different' } });
    const presentation = createTeamApprovalPresentation([other], FIXTURE_TEAM_RUN.id, [live]);
    expect(presentation.requests.map(message => message.id)).toEqual([live.id]);
    expect(presentation.requests[0]?.pendingRequest).toEqual(live.pendingRequest);
  });

  it('does not promote a cached typed handle after the current live set is empty', () => {
    expect(createTeamApprovalPresentation([request()], FIXTURE_TEAM_RUN.id, []).requests).toEqual([]);
  });

  it.each(['code', 'work'] as const)('%s has one actionable rail copy even after history changes the message row ID', async surface => {
    const live = request();
    const messages = mergeCodeApprovals([{ ...live, id: 'stored-row', pendingRequest: undefined }], [live]);
    const view = renderHost(messages, { surface });
    expect(view.getAllByRole('button', { name: '批准并继续' })).toHaveLength(1);
    expect(view.container.querySelectorAll('.team-workspace__person .approval-card')).toHaveLength(0);
    expect(view.container.querySelector('.team-run__approvals')).not.toBeNull();
    await act(async () => fireEvent.click(view.getByRole('button', { name: '批准并继续' })));
    expect(view.respond).toHaveBeenCalledWith('request-1', true);
  });

  it('keeps the rail when the member pane is selected and preserves unhosted member requests inline', () => {
    const main = request();
    const member = request({ id: 'member-row', approvalId: 'member-request', description: '当前成员写入',
      pendingRequest: { ...main.pendingRequest!, requestId: 'member-request' },
      requester: { kind: 'subagent', taskId: 'task', executionId: 'execution', teamRunId: FIXTURE_TEAM_RUN.id,
        memberId: 'member', displayName: '当前成员', role: 'worker' } });
    const other = request({ ...member, id: 'other-row', approvalId: 'other-request', description: '另一成员的唯一入口',
      pendingRequest: { ...main.pendingRequest!, requestId: 'other-request' },
      requester: { ...member.requester!, teamRunId: 'another-team' } });
    const view = renderHost([main, member, other]);
    const rail = view.container.querySelector<HTMLElement>('.team-run__approvals')!;
    expect(within(rail).getAllByRole('button', { name: '批准并继续' })).toHaveLength(2);
    expect(view.container.querySelectorAll('.team-workspace__person .approval-card')).toHaveLength(1);
    expect(view.getByText('另一成员的唯一入口')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '团队' }));
    expect(view.container.querySelector<HTMLElement>('.team-workspace')?.dataset.mobilePane).toBe('team');
    expect(within(rail).getAllByRole('button', { name: '批准并继续' })).toHaveLength(2);
  });

  it.each([{ rail: false }, { person: true }])('does not suppress an inline request when its host rail is absent: %j', options => {
    const view = renderHost([request()], options);
    expect(view.getAllByRole('button', { name: '批准并继续' })).toHaveLength(1);
    expect(view.container.querySelector('.message--approval')).not.toBeNull();
  });

  it('requires exact message ID, request ID and authority and leaves settled history visible', () => {
    const live = request();
    const hostedApprovals = createTeamApprovalPresentation([live], FIXTURE_TEAM_RUN.id).hostedApprovals;
    const cases = [request({ id: 'different-row' }),
      request({ approvalId: 'different-request', pendingRequest: { ...live.pendingRequest!, requestId: 'different-request' } }),
      request({ authority: 'managed', pendingRequest: undefined }), request({ status: 'approved' })];
    for (const message of cases) {
      const view = render(<ConversationPresentation.Provider value={{ embedded: true, hostedApprovals }}>
        <Message message={message} onRespondApproval={async () => true} />
      </ConversationPresentation.Provider>);
      expect(view.container.querySelector('.approval-card')).not.toBeNull();
      view.unmount();
    }
  });

  it('never gives a persisted pending card without its live handle an approval action', () => {
    const view = render(<Message message={request({ pendingRequest: undefined })} onRespondApproval={async () => true} />);
    expect(view.queryByRole('button', { name: '批准并继续' })).toBeNull();
    expect(view.getByText('已失效')).toBeTruthy();
  });

  it('prepares rail IDs only for live requests from this team and nothing without a team', () => {
    const live = request();
    const stale = request({ id: 'history', pendingRequest: undefined });
    const mismatch = request({ id: 'mismatch', pendingRequest: { ...live.pendingRequest!, requestId: 'wrong-request' } });
    const approved = request({ id: 'settled', status: 'approved' });
    const presentation = createTeamApprovalPresentation([live, stale, mismatch, approved], FIXTURE_TEAM_RUN.id);
    expect(presentation.requests).toEqual([live]);
    expect(presentation.hostedApprovals).toEqual([{ messageId: 'live-row', approvalId: 'request-1', authority: 'code' }]);
    expect(createTeamApprovalPresentation([live]).hostedApprovals).toEqual([]);
  });
});
