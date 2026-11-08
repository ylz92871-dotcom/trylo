import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentConversationSurfaceProps } from './AgentConversationSurface';
import { ApprovalCard } from './ApprovalCard';
import { ChatPanel, type ChatPanelProps } from './ChatPanel';
import type { ApprovalMessage } from './types';
import type { FilePath } from '../../host-adapter/types';

vi.mock('./InputBar', () => ({ InputBar: () => null }));
// Isolate layout/virtualization while keeping the actual decision card and surface.
vi.mock('./MessageList', () => ({ MessageList: (props: AgentConversationSurfaceProps) => (
  <>{props.messages.filter((m): m is ApprovalMessage => m.kind === 'approval').map(message => (
    <ApprovalCard key={message.id} message={message} onRespond={props.onRespondApproval} onOpenPreview={props.onOpenApprovalPreview} />
  ))}</>
) }));
afterEach(cleanup);

const request: ApprovalMessage = {
  id: 'code-approval:req-1', kind: 'approval', role: 'system', createdAt: 1000,
  authority: 'code', approvalId: 'req-1', type: 'write_file', status: 'pending', description: 'Write proof.txt',
  preview: { kind: 'diff', title: 'Write file', target: 'proof.txt', diff: { path: 'proof.txt', original: '', modified: 'proof', truncated: false } },
};
const noop = () => undefined;
function panel(topMode: 'code' | 'work', onRespondApproval = vi.fn(), onOpenApprovalPreview = vi.fn()): ChatPanelProps {
  return {
    // These host facades are outside the isolated approval rendering boundary.
    context: {} as ChatPanelProps['context'], artifactHost: {} as ChatPanelProps['artifactHost'],
    workspaceRoot: '/proof' as FilePath, activeSession: null, topMode, codeMode: 'agent',
    onCodeModeChange: noop, onApplyPlan: noop, messages: [request], text: '', onTextChange: noop, onSend: noop,
    workMessages: [request], workInput: '', onWorkInputChange: noop, onWorkSend: noop, workRunning: true, workCanSend: false,
    permissionLevel: 'ask', permissionSource: 'conversation', onPermissionLevelChange: noop,
    contextUsed: 0, contextWindow: 128000, model: 'test', onCompact: noop, compacting: false, activeProcessId: 'process-1',
    attachments: [], onAddAttachment: noop, onRemoveAttachment: noop, attachmentLoading: 0, failed: [], onDismissFailed: noop,
    workAttachments: [], onAddWorkAttachment: noop, onRemoveWorkAttachment: noop, workAttachmentLoading: 0, workFailed: [], onDismissWorkFailed: noop,
    isDragging: false, editingMessageId: null, onEditMessage: noop, onSaveEdit: noop, onCancelEdit: noop,
    onRespondApproval, onOpenApprovalPreview,
  };
}

it.each(['code', 'work'] as const)('%s approvals can approve, deny and preview through the host callbacks', async topMode => {
  const respond = vi.fn();
  const preview = vi.fn();
  render(<ChatPanel {...panel(topMode, respond, preview)} />);
  fireEvent.click(screen.getByRole('button', { name: '查看变更' }));
  expect(preview).toHaveBeenCalledWith('req-1');
  expect(respond).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '批准并继续' })));
  expect(respond).toHaveBeenCalledWith('req-1', true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '拒绝' })));
  expect(respond).toHaveBeenCalledWith('req-1', false);
});
