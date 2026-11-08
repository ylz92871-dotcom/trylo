import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCard } from './ToolCard'
import type { ToolMessage } from './types'

const request = {
  schemaVersion: 1,
  kind: 'skill_pending_review_request',
  requestRef: 'review-7',
  scope: 'D:/reports',
  pendingId: 'pending-7',
  expectedHash: 'sha256:' + 'a'.repeat(64),
  name: 'report-review',
  action: 'create',
  reason: '复用来源核对方法',
  status: 'awaiting_user_approval',
  sourceRefs: ['issue:7', 'grant:7'],
}
function message(patch: Partial<ToolMessage> = {}): ToolMessage {
  return {
    id: 'tool-7',
    kind: 'tool',
    role: 'assistant',
    turnId: 'turn-7',
    createdAt: 7,
    tool: 'skill_proposals',
    status: 'done',
    summary: '请求审阅',
    outputText: JSON.stringify(request),
    ...patch,
  }
}
afterEach(cleanup)
describe('native skill review navigation', () => {
  it('offers the exact original pending version from a successful tool result without approving it', () => {
    const opened = vi.fn()
    window.addEventListener('trylo:review-skill-pending', opened)
    try {
      render(<ToolCard message={message()} />)
      fireEvent.click(screen.getByRole('button', { name: '审阅此技能提案' }))
      expect(opened).toHaveBeenCalledOnce()
      expect((opened.mock.calls[0]![0] as CustomEvent).detail).toMatchObject(request)
      expect(screen.queryByRole('button', { name: /批准/ })).toBeNull()
    } finally {
      window.removeEventListener('trylo:review-skill-pending', opened)
    }
  })
  it.each([
    { tool: 'Bash' },
    { status: 'error' as const },
    { outputText: JSON.stringify({ ...request, expectedHash: 'changed' }) },
    { outputText: JSON.stringify({ ...request, status: 'approved' }) },
  ])('does not promote an unrelated or invalid result into a review action: %j', (patch) => {
    render(<ToolCard message={message(patch)} />)
    expect(screen.queryByRole('button', { name: '审阅此技能提案' })).toBeNull()
  })
})
