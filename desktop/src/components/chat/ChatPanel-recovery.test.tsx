// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ChatPanel, type ChatPanelProps } from './ChatPanel'
afterEach(cleanup)
const noop = () => undefined
function props(mode: 'code' | 'work'): ChatPanelProps {
  const messages: ChatPanelProps['messages'] = [
    {
      id: 'first',
      kind: 'text',
      role: 'user',
      text: 'original task',
      turnId: 'first',
      createdAt: 1,
    },
    {
      id: 'later',
      kind: 'text',
      role: 'user',
      text: 'why did it stop?',
      turnId: 'later',
      createdAt: 2,
    },
    {
      id: 'error',
      kind: 'error',
      role: 'system',
      userMessage: 'previous execution detached',
      diagnosticId: 'fixture-detached',
      createdAt: 3,
    },
  ]
  return {
    context: {} as ChatPanelProps['context'],
    artifactHost: {} as ChatPanelProps['artifactHost'],
    workspaceRoot: 'D:/recovery',
    activeSession: null,
    topMode: mode,
    codeMode: 'agent',
    hasApiKey: true,
    onCodeModeChange: noop,
    onApplyPlan: noop,
    messages,
    text: '',
    onTextChange: noop,
    onSend: noop,
    workMessages: messages,
    workInput: '',
    onWorkInputChange: noop,
    onWorkSend: noop,
    workRunning: true,
    running: true,
    workCanSend: false,
    sendingDisabled: true,
    recoveryState: { kind: 'reconnecting' },
    workRecoveryState: { kind: 'reconnecting' },
    permissionLevel: 'ask',
    permissionSource: 'conversation',
    onPermissionLevelChange: noop,
    contextUsed: 0,
    contextWindow: 128000,
    model: 'fixture',
    onCompact: noop,
    compacting: false,
    activeProcessId: null,
    attachments: [],
    onAddAttachment: noop,
    onRemoveAttachment: noop,
    attachmentLoading: 0,
    failed: [],
    onDismissFailed: noop,
    workAttachments: [],
    onAddWorkAttachment: noop,
    onRemoveWorkAttachment: noop,
    workAttachmentLoading: 0,
    workFailed: [],
    onDismissWorkFailed: noop,
    isDragging: false,
    editingMessageId: null,
    onEditMessage: noop,
    onSaveEdit: noop,
    onCancelEdit: noop,
  }
}
it.each(['code', 'work'] as const)(
  '%s displays native output reconnection instead of new-turn preparation after a failed send',
  (mode) => {
    render(<ChatPanel {...props(mode)} />)
    expect(screen.queryByText('正在准备…')).toBeNull()
    expect(screen.getAllByText('正在重新连接…').length).toBeGreaterThan(0)
  },
)
