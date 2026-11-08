import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'
import { DesktopLibrariesPanel } from './DesktopLibrariesPanel'
import { settingsDefaults } from '../../settings/settings-store'
import type { DesktopCollaborationResources } from '../../collaboration-learning/desktop-resources'

vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }))
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }))
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }))
vi.mock('../../experts', () => ({
  ExpertLibraryPanel: () => (
    <form aria-label="专家原库表单" onSubmit={(event) => event.preventDefault()}>
      <button type="submit">原库操作</button>
    </form>
  ),
}))
afterEach(() => {
  cleanup()
  localStorage.clear()
})
it('mounts the owner library without nested forms or submitting global settings from a library action', () => {
  const onSave = vi.fn()
  const onClose = vi.fn(),
    onRequestTemporaryExpert = vi.fn()
  const resources = { scope: 'D:/workspace', experts: {} } as DesktopCollaborationResources
  render(
    <SettingsModal
      open
      initial={settingsDefaults}
      initialTab="libraries"
      collaborationResources={resources}
      onSave={onSave}
      onClose={onClose}
      onRequestTemporaryExpert={onRequestTemporaryExpert}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '专家库' }))
  expect(screen.getByRole('form', { name: '专家原库表单' })).toBeInTheDocument()
  expect(document.querySelector('form form')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '原库操作' }))
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByText(/不入库.*不代表当前团队已采用/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '向当前 Personal Agent 申请临时专家' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(onRequestTemporaryExpert).toHaveBeenCalledOnce()
  expect(onSave).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  expect(onSave).toHaveBeenCalledOnce()
})
it('keeps the chosen library on unrelated host rerenders and follows a new focused request', () => {
  const view = render(
    <DesktopLibrariesPanel focus={{ owner: 'tool', requestId: 'request-a' }} />,
  )
  fireEvent.click(screen.getByRole('button', { name: '专家库' }))
  expect(screen.getByRole('button', { name: '专家库' })).toHaveAttribute('aria-pressed', 'true')
  view.rerender(
    <DesktopLibrariesPanel focus={{ owner: 'tool', requestId: 'request-a' }} />,
  )
  expect(screen.getByRole('button', { name: '专家库' })).toHaveAttribute('aria-pressed', 'true')
  view.rerender(
    <DesktopLibrariesPanel focus={{ owner: 'tool', requestId: 'request-b' }} />,
  )
  expect(screen.getByRole('button', { name: '工具库' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText('request-b')).toBeInTheDocument()
})
