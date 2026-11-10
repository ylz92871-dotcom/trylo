// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'
import { loadSettings, settingsDefaults } from '../../settings/settings-store'
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }))
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }))
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }))
afterEach(() => { cleanup(); window.localStorage.clear() })

it('persists independent image/video connections while preserving the chat connection', () => {
  render(<SettingsModal open initial={{ ...settingsDefaults, apiKey: 'CHAT_KEY', apiModel: 'chat-model' }} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '图片与视频' }))
  fireEvent.click(screen.getByLabelText('启用图片生成 API'))
  fireEvent.change(screen.getByLabelText('图片生成服务地址'), { target: { value: 'https://ark.cn-beijing.volces.com/api/v3' } })
  fireEvent.change(screen.getByLabelText('图片生成模型 ID'), { target: { value: 'image-model' } })
  fireEvent.change(screen.getByLabelText('图片生成 API 密钥'), { target: { value: 'IMAGE_KEY' } })
  fireEvent.change(screen.getByLabelText('视频生成接口格式'), { target: { value: 'replicate-video' } })
  fireEvent.change(screen.getByLabelText('视频生成模型 ID'), { target: { value: 'owner/video-model' } })
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  expect(loadSettings()).toMatchObject({ apiKey: 'CHAT_KEY', apiModel: 'chat-model', mediaGeneration: {
    image: { enabled: true, model: 'image-model', apiKey: 'IMAGE_KEY' }, video: { enabled: false, protocol: 'replicate-video', model: 'owner/video-model' },
  } })
})
