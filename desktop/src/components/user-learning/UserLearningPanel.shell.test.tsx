import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { UserLearningPanel, type UserLearningPanelProps } from './UserLearningPanel'
import { emptySnapshot } from '../../user-learning/store'
import type { LearningPort } from '../../learning/learning-port'
import type { DesktopCollaborationResources } from '../../collaboration-learning/desktop-resources'
import { INSPECTOR_PREFS_KEY, loadInspectorPrefs } from './inspector-prefs'
import type { ChatMessage } from '../chat/types'

const tracked = vi.hoisted(() => ({
  mounts: 0,
  removeDetailOpenerOnRefresh: false,
  libraryVisits: [] as { scope?: string; requestId?: string }[],
}))
vi.mock('./AgentLearningWorkspace', () => ({
  AgentLearningWorkspace: (props: {
    section: string
    refreshKey?: number
    onPendingCountChange?: (count: number) => void
    onOpenLibrary?: (owner: 'tool' | 'expert', requestId?: string) => void
  }) => {
    useEffect(() => {
      tracked.mounts += 1
      props.onPendingCountChange?.(3)
    }, [])
    return <section aria-label="Connected agent workspace">
      <output aria-label="当前学习分区">{props.section}</output>
      <output aria-label="学习刷新版本">{props.refreshKey ?? 0}</output>
      <button type="button" onClick={() => props.onOpenLibrary?.('expert')}>打开专家库</button>
      {tracked.removeDetailOpenerOnRefresh && !props.refreshKey && <button
        type="button" onClick={() => props.onOpenLibrary?.('expert', 'expert-review-7')}
      >打开专家库处理此申请</button>}
      <button type="button" onClick={() => props.onOpenLibrary?.('tool', 'review-7')}>打开工具申请</button>
    </section>
  },
}))
vi.mock('../app-shell/DesktopLibrariesPanel', () => ({
  DesktopLibrariesPanel: (props: {
    resources?: DesktopCollaborationResources
    initialOwner?: 'tool' | 'expert'
    focus?: { owner: 'tool' | 'expert'; requestId: string }
    approvals?: readonly ChatMessage[]
    onRespondApproval?: (id: string, allow: boolean) => void
    onRequestTemporaryExpert?: () => void
  }) => {
    tracked.libraryVisits.push({ scope: props.resources?.scope, requestId: props.focus?.requestId })
    return <div aria-label="Connected library">
      <span>{props.initialOwner}</span>
      <span>{props.resources?.scope}</span>
      {props.focus && <span>{props.focus.requestId}</span>}
      {props.approvals?.map((approval) => <button
        type="button" key={approval.id}
        onClick={() => props.onRespondApproval?.(approval.id, true)}
      >允许 {approval.id}</button>)}
      {props.onRequestTemporaryExpert && <button
        type="button" onClick={props.onRequestTemporaryExpert}
      >申请临时专家</button>}
    </div>
  },
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  tracked.mounts = 0
  tracked.removeDetailOpenerOnRefresh = false
  tracked.libraryVisits = []
})

function panel(overrides: Partial<UserLearningPanelProps> = {}) {
  const onSettingsChange = vi.fn()
  const props: UserLearningPanelProps = {
    open: true,
    snapshot: emptySnapshot(1, 'local-user'),
    settings: { enabled: true, defaultMode: 'shadow', dimensionMode: {}, cognitionEnabled: true },
    learningPort: {} as LearningPort,
    resources: { scope: 'D:/workspace/Reports' } as DesktopCollaborationResources,
    onClose: vi.fn(),
    onSettingsChange,
    ...overrides,
  }
  const view = render(<UserLearningPanel {...props} />)
  return { onSettingsChange, props, ...view }
}

describe('agent learning shell integration', () => {
  it('routes every accepted learning domain while leaving user settings and lazy mounting intact', () => {
    const { onSettingsChange } = panel()
    expect(screen.queryByRole('region', { name: 'Connected agent workspace' })).toBeNull()
    expect(tracked.mounts).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    const sidebar = screen.getByRole('navigation', { name: '学习分区' })
    for (const [label, section] of [
      ['待审批', 'pending'], ['已批准记录', 'approved'], ['方法学习', 'method'],
      ['技能学习', 'skill'], ['工具学习', 'tool'], ['工作流学习', 'workflow'],
      ['协作学习', 'collaboration'], ['学习安排', 'schedule'],
    ]) {
      fireEvent.click(within(sidebar).getByRole('button', { name: new RegExp(label!) }))
      expect(screen.getByLabelText('当前学习分区').textContent).toBe(section)
    }
    expect(tracked.mounts).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /用户学习/ }))
    expect(screen.queryByRole('region', { name: 'Connected agent workspace' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '应用设置' }))
    const firstSetting = within(screen.getByRole('list')).getAllByRole('listitem')[0]!
    fireEvent.click(within(firstSetting).getByRole('button', { name: '应用偏好' }))
    expect(onSettingsChange).toHaveBeenCalledWith({ dimensionMode: { agent_autonomy: 'enforced' } })
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    expect(tracked.mounts).toBe(1)
    expect(screen.getByLabelText('当前学习分区').textContent).toBe('schedule')
  })

  it('returns from each library to the same mounted queue and refreshes it without losing the opener', async () => {
    panel()
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    fireEvent.click(screen.getByRole('button', { name: '工具学习' }))
    const opener = screen.getByRole('button', { name: '打开专家库' })
    opener.focus()
    fireEvent.click(opener)
    const expertLibrary = screen.getByLabelText('Connected library')
    expect(expertLibrary.textContent).toContain('expert')
    expect(expertLibrary.textContent).toContain('D:/workspace/Reports')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '返回学习' }))
    fireEvent.click(screen.getByRole('button', { name: '返回学习' }))
    expect(screen.getByLabelText('当前学习分区').textContent).toBe('tool')
    expect(tracked.mounts).toBe(1)
    expect(screen.getByLabelText('学习刷新版本').textContent).toBe('1')
    await waitFor(() => expect(document.activeElement).toBe(opener))

    fireEvent.click(screen.getByRole('button', { name: '打开工具申请' }))
    expect(screen.getByLabelText('Connected library').textContent).toContain('review-7')
    fireEvent.click(screen.getByRole('button', { name: '返回学习' }))
    expect(tracked.mounts).toBe(1)
    expect(screen.getByLabelText('学习刷新版本').textContent).toBe('2')
  })

  it('passes library authorization to the original owner and closes before requesting a temporary expert', () => {
    const events: string[] = []
    const onRespondLibraryApproval = vi.fn()
    const onClose = vi.fn(() => { events.push('close') })
    const onRequestTemporaryExpert = vi.fn(() => { events.push('request') })
    const { onSettingsChange } = panel({
      libraryApprovals: [{ id: 'library-approval-7', kind: 'approval' } as ChatMessage],
      onRespondLibraryApproval,
      onClose,
      onRequestTemporaryExpert,
    })
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开专家库' }))
    fireEvent.click(screen.getByRole('button', { name: '允许 library-approval-7' }))
    expect(onRespondLibraryApproval).toHaveBeenCalledWith('library-approval-7', true)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '申请临时专家' }))
    expect(events).toEqual(['close', 'request'])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onRequestTemporaryExpert).toHaveBeenCalledTimes(1)
    expect(onSettingsChange).not.toHaveBeenCalled()
  })

  it('keeps keyboard focus inside learning when refreshing removes the library opener', async () => {
    tracked.removeDetailOpenerOnRefresh = true
    panel()
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    const opener = screen.getByRole('button', { name: '打开专家库处理此申请' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByLabelText('Connected library').textContent).toContain('expert-review-7')
    fireEvent.click(screen.getByRole('button', { name: '返回学习' }))
    expect(opener.isConnected).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '学习' })))
    expect(tracked.mounts).toBe(1)
  })

  it('invalidates a library request before a new workspace can receive the old request ID', () => {
    const { props, rerender } = panel()
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    fireEvent.click(screen.getByRole('button', { name: '工具学习' }))
    fireEvent.click(screen.getByRole('button', { name: '打开工具申请' }))
    expect(screen.getByLabelText('Connected library').textContent).toContain('review-7')
    rerender(<UserLearningPanel {...props} resources={{ scope: 'D:/workspace/Other' } as DesktopCollaborationResources} />)
    expect(screen.queryByLabelText('Connected library')).toBeNull()
    expect(tracked.libraryVisits.some((visit) => visit.scope === 'D:/workspace/Other' && visit.requestId === 'review-7')).toBe(false)
    expect(screen.getByLabelText('当前学习分区').textContent).toBe('tool')
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '学习' }))
    expect(tracked.mounts).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '打开专家库' }))
    expect(screen.getByLabelText('Connected library').textContent).toContain('D:/workspace/Other')
    expect(screen.getByLabelText('Connected library').textContent).not.toContain('review-7')
  })

  it('rereads the queue when leaving a library through either agent navigation control', () => {
    panel()
    fireEvent.click(screen.getByRole('button', { name: /智能体学习/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开专家库' }))
    fireEvent.click(screen.getByRole('button', { name: '技能学习' }))
    expect(screen.queryByLabelText('Connected library')).toBeNull()
    expect(screen.getByLabelText('当前学习分区').textContent).toBe('skill')
    expect(screen.getByLabelText('学习刷新版本').textContent).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: '打开专家库' }))
    fireEvent.change(screen.getByRole('combobox', { name: '智能体学习分区' }), { target: { value: 'workflow' } })
    expect(screen.queryByLabelText('Connected library')).toBeNull()
    expect(screen.getByLabelText('当前学习分区').textContent).toBe('workflow')
    expect(screen.getByLabelText('学习刷新版本').textContent).toBe('2')
    expect(tracked.mounts).toBe(1)
  })

  it('migrates the former tool route while preserving user-learning filters', () => {
    localStorage.setItem(INSPECTOR_PREFS_KEY, JSON.stringify({
      module: 'cognition', agentTab: 'tools', cognitionTab: 'evidence', surfaceFilter: 'work',
      channelFilter: 'cognition', dimensionFilter: 'verification_audit', strengthFilter: 'authoritative',
    }))
    expect(loadInspectorPrefs()).toMatchObject({
      module: 'cognition', agentTab: 'tool', cognitionTab: 'evidence', surfaceFilter: 'work',
      channelFilter: 'cognition', dimensionFilter: 'verification_audit', strengthFilter: 'authoritative',
    })
  })
})
