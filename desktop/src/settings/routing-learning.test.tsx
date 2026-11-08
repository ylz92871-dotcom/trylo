import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { loadSettings, saveSettings, settingsDefaults } from './settings-store'
import { SettingsModal } from '../components/app-shell/SettingsModal'
import { settingsForCodeReplay, settingsForCodeRun } from '../runtime/conversation-run-supervisor'
import { buildTryloV1Args } from '../host-adapter/trylo-v1-runner'
import type { FilePath } from '../host-adapter/types'
import { useState } from 'react'

vi.mock('../components/app-shell/AppearanceSettings', () => ({ AppearanceSettings: () => null }))
vi.mock('../components/app-shell/WorkToolsSettings', () => ({ WorkToolsSettings: () => null }))
vi.mock('../components/app-shell/SkillsModal', () => ({ SkillsModal: () => null }))
afterEach(() => {
  cleanup()
  localStorage.clear()
})
const cwd = 'D:/routing-retirement' as FilePath

it('migrates an old independent routing config into a visible settings notice without a runtime configuration', () => {
  localStorage.setItem(
    'trylo:settings:v1',
    JSON.stringify({
      routingLearningConfig: { enabled: true, budgetTokens: 4000 },
      userLearning: { enabled: true },
    }),
  )
  const settings = loadSettings()
  expect(settings).not.toHaveProperty('routingLearningConfig')
  expect(settings.settingsNotices).toEqual(['routing-learning-retired'])
  expect(settings.userLearning.enabled).toBe(true)
  expect(settings.checkLearning?.enabled).not.toBe(true)
  render(
    <SettingsModal
      open
      initial={{ ...settings, apiModel: 'unsaved-model' }}
      initialTab="learning"
      onClose={vi.fn()}
    />,
  )
  expect(screen.getByRole('status')).toHaveTextContent('独立路由学习已退役')
  expect(screen.queryByRole('checkbox', { name: '启用路由学习' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('每轮路由学习额度（tokens）')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '知道了' }))
  expect(screen.queryByText(/独立路由学习已退役/)).not.toBeInTheDocument()
  expect(loadSettings().settingsNotices).toEqual([])
  expect(JSON.parse(localStorage.getItem('trylo:settings:v1')!)).not.toHaveProperty(
    'routingLearningConfig',
  )
  expect(loadSettings().userLearning.enabled).toBe(true)
  expect(loadSettings().apiModel).toBe(settings.apiModel)
  localStorage.setItem(
    'trylo:settings:v1',
    JSON.stringify({ routingLearningConfig: { enabled: false, budgetTokens: 0 } }),
  )
  expect(loadSettings()).not.toHaveProperty('routingLearningConfig')
  expect(loadSettings().settingsNotices).toEqual(['routing-learning-retired'])
})

it('fresh settings have no independent routing state, and normal/replay launches emit no retired flags', () => {
  expect(settingsDefaults).not.toHaveProperty('routingLearningConfig')
  const legacy = {
    ...settingsDefaults,
    cliPath: 'D:/trylo/main.js',
    routingLearningConfig: { enabled: true, budgetTokens: 4000 },
    userLearning: { ...settingsDefaults.userLearning, enabled: true },
  }
  for (const run of [settingsForCodeRun(legacy, cwd), settingsForCodeReplay(legacy, cwd)]) {
    expect(Object.keys(run).some((key) => key.startsWith('routing'))).toBe(false)
    expect(run.learning).toBe('user')
    expect(run.checkLearning?.enabled).not.toBe(true)
    expect(buildTryloV1Args(run).args.some((arg) => arg.startsWith('--routing'))).toBe(false)
  }
  saveSettings(loadSettings())
  expect(loadSettings()).not.toHaveProperty('routingLearningConfig')
})

it('notice acknowledgment updates the cached owner without saving or resetting a draft, and stays dismissed on reopen/save', () => {
  localStorage.setItem(
    'trylo:settings:v1',
    JSON.stringify({
      routingLearningConfig: { enabled: true, budgetTokens: 4000 },
      apiModel: 'stored-model',
      workflowLearning: { enabled: true, tokenBudget: 16000 },
      collaborationLearning: { enabled: true, tokenBudget: 16000 },
    }),
  )
  const initial = loadSettings(),
    onSave = vi.fn()
  function CachedParent({ open }: { open: boolean }) {
    const [settings, setSettings] = useState(initial)
    return (
      <SettingsModal
        open={open}
        initial={settings}
        onClose={() => undefined}
        onSave={onSave}
        onNoticeDismissed={(notice) =>
          setSettings((current) => ({
            ...current,
            settingsNotices: (current.settingsNotices ?? []).filter((value) => value !== notice),
          }))
        }
      />
    )
  }
  const view = render(<CachedParent open />)
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'unsaved-draft' } })
  fireEvent.click(screen.getByRole('button', { name: '知道了' }))
  expect(screen.getByLabelText('模型名称')).toHaveValue('unsaved-draft')
  expect(loadSettings().apiModel).toBe('stored-model')
  expect(onSave).not.toHaveBeenCalled()
  view.rerender(<CachedParent open={false} />)
  view.rerender(<CachedParent open />)
  expect(screen.queryByText(/独立路由学习已退役/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  const saved = loadSettings()
  expect(saved.settingsNotices).toEqual([])
  expect(saved.apiModel).toBe('stored-model')
  expect(saved.workflowLearning).toEqual(initial.workflowLearning)
  expect(saved.collaborationLearning).toEqual(initial.collaborationLearning)
})
