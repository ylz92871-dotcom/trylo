// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'
import { connectionFields, loadSettings, settingsDefaults } from '../../settings/settings-store'
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }))
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }))
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }))
afterEach(() => {
  cleanup()
  localStorage.clear()
})
it('has no runtime selector or CLI entry and still saves ordinary preferences', () => {
  const initial = { ...settingsDefaults, apiModel: 'recording-model' }
  const onSave = vi.fn()
  render(
    <SettingsModal
      open
      initialTab="behavior"
      initial={initial}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  )
  expect(screen.queryByLabelText('CLI runtime')).not.toBeInTheDocument()
  expect(screen.queryByText('CLI path')).not.toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /旧 CLI/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  expect(onSave).toHaveBeenCalledOnce()
  expect(connectionFields(loadSettings())).toEqual(connectionFields(initial))
  expect(loadSettings()).not.toHaveProperty('cliRuntimeProtocol')
})

it('renders as a standalone full-window settings view with macOS drag regions, back button, and Cmd+, close toggle', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform')
  Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
  try {
    const onClose = vi.fn()
    const { container } = render(
      <SettingsModal
        open
        initialTab="connection"
        initial={settingsDefaults}
        onClose={onClose}
      />,
    )
    expect(container.querySelector('.settings-screen')).toBeTruthy()
    expect(container.querySelector('.settings-modal__backdrop')).toBeNull()
    expect(container.querySelector('.settings-screen__rail-header')).toHaveAttribute('data-tauri-drag-region', '')
    expect(container.querySelector('.settings-screen__topbar')).toHaveAttribute('data-tauri-drag-region', '')
    const backBtn = screen.getByRole('button', { name: '返回应用' })
    expect(backBtn).toHaveAttribute('data-tauri-drag-region', 'false')

    fireEvent.click(backBtn)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: ',', metaKey: true })
    expect(onClose).toHaveBeenCalledTimes(2)
  } finally {
    if (originalPlatform) Object.defineProperty(window.navigator, 'platform', originalPlatform)
    else delete (window.navigator as { platform?: string }).platform
  }
})
