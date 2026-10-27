import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InputBar } from '../chat/InputBar'
import { SettingsModal } from './SettingsModal'
import { loadSettings, settingsDefaults, connectionFields } from '../../settings/settings-store'
import { contextModelKey } from '../../settings/context-window'

vi.mock('../../account/use-platform-models', () => ({
  usePlatformModels: () => ({
    models: [{ id: 'pool-model', chat: true, pool: 'free', contextLength: 128_000 }],
    loading: false,
    message: '',
  }),
}))
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }))
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }))
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }))

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

it('keeps context configuration out of both composers while retaining model and attachment controls', () => {
  const onSend = vi.fn()
  const props = {
    codeMode: 'agent' as const,
    onCodeModeChange: vi.fn(),
    onSend,
    text: 'unsent draft',
    onTextChange: vi.fn(),
    messages: [],
    running: false,
    contextUsed: 0,
    contextWindow: 200_000,
    model: 'fixture',
    configuredModel: 'fixture',
    onSelectPool: vi.fn(),
    compacting: false,
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onCompact: vi.fn(),
    activeProcessId: null,
    permissionLevel: 'workspace_write' as const,
    permissionSource: 'settings' as const,
    onPermissionLevelChange: vi.fn(),
    contextPreference: {},
    contextModelKey: 'fixture',
    onContextPreferenceChange: vi.fn(),
  }
  for (const conversationKind of ['code', 'work'] as const) {
    const view = render(<InputBar {...props} conversationKind={conversationKind} />)
    expect(screen.queryByRole('button', { name: /上下文窗口：/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDefined()
    expect(screen.getByRole('button', { name: /^Model:/ })).toBeDefined()
    expect(onSend).not.toHaveBeenCalled()
    view.unmount()
  }
})

it('edits the active pool context in model settings without switching or clearing its connection', () => {
  const initial = { ...settingsDefaults, apiModel: 'own-model', poolModel: 'pool-model' }
  const onSave = vi.fn()
  render(<SettingsModal open initial={initial} onSave={onSave} onClose={vi.fn()} />)
  expect((screen.getByLabelText('配置模型') as HTMLSelectElement).value).toBe('pool:pool-model')
  expect(screen.getByText(/实际使用 128,000 tokens/)).toBeDefined()
  fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '64000' } })
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  const saved = loadSettings()
  expect(saved.poolModel).toBe(initial.poolModel)
  expect(connectionFields(saved)).toEqual(connectionFields(initial))
  expect(saved.modelContextPreferences?.[contextModelKey(initial)]?.window).toBe(64_000)
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ poolModel: initial.poolModel }),
    'preferences',
  )
})

it('configures a saved model window without activating that profile', () => {
  const profile = {
    id: 'saved',
    name: 'Saved model',
    ...connectionFields(settingsDefaults),
    apiModel: 'saved-model',
  }
  const initial = {
    ...settingsDefaults,
    apiModel: 'own-model',
    poolModel: 'pool-model',
    modelProfiles: [profile],
  }
  render(<SettingsModal open initial={initial} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('配置模型'), { target: { value: 'profile:saved' } })
  fireEvent.change(screen.getByLabelText('模型或服务端上限（tokens）'), {
    target: { value: '1000000' },
  })
  fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '400000' } })
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  const saved = loadSettings()
  expect(saved.poolModel).toBe('pool-model')
  expect(saved.apiModel).toBe('own-model')
  expect(saved.activeModelProfileId).toBe(initial.activeModelProfileId)
  expect(saved.modelContextPreferences?.[contextModelKey({ ...profile, poolModel: '' })]).toEqual({
    window: 400_000,
    capacity: 1_000_000,
  })
})
