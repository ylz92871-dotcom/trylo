import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatPanel, type ChatPanelProps } from './ChatPanel'

afterEach(cleanup)
const noop = () => undefined
function props(mode: 'code' | 'work'): ChatPanelProps {
  return {
    context: {} as ChatPanelProps['context'], artifactHost: {} as ChatPanelProps['artifactHost'],
    workspaceRoot: 'D:/parity', activeSession: null, topMode: mode, codeMode: 'agent',
    onCodeModeChange: noop, onApplyPlan: noop, messages: [], text: '', onTextChange: noop, onSend: noop,
    workMessages: [], workInput: '', onWorkInputChange: noop, onWorkSend: noop, workRunning: false, workCanSend: true,
    permissionLevel: 'ask', permissionSource: 'conversation', onPermissionLevelChange: noop,
    contextUsed: 0, contextWindow: 128000, model: 'test', onCompact: noop, compacting: false, activeProcessId: null,
    attachments: [], onAddAttachment: noop, onRemoveAttachment: noop, attachmentLoading: 0, failed: [], onDismissFailed: noop,
    workAttachments: [], onAddWorkAttachment: noop, onRemoveWorkAttachment: noop, workAttachmentLoading: 0, workFailed: [], onDismissWorkFailed: noop,
    isDragging: false, editingMessageId: null, onEditMessage: noop, onSaveEdit: noop, onCancelEdit: noop,
  }
}

it.each(['code', 'work'] as const)('%s gives the same actionable model-setup notice once', mode => {
  const openSettings = vi.fn()
  render(<ChatPanel {...props(mode)} hasApiKey={false} onOpenSettings={openSettings} />)
  expect(screen.getAllByText('尚未配置模型服务')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
  expect(openSettings).toHaveBeenCalledOnce()
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
})

it.each(['code', 'work'] as const)('%s omits setup when a personal or account model is available', mode => {
  const view = render(<ChatPanel {...props(mode)} hasApiKey />)
  expect(screen.queryByText('尚未配置模型服务')).toBeNull()
  view.rerender(<ChatPanel {...props(mode)} hasApiKey={false} poolModel="account-model" />)
  expect(screen.queryByText('尚未配置模型服务')).toBeNull()
})
