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
