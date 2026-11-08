import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CentralRuntimeStatus } from './CentralRuntimeStatus'
import { controlCentralRuntime } from '../../agent-learning/central-runtime'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import type { CentralRuntimeState } from '../../agent-learning/central-runtime'

vi.mock('../../agent-learning/central-runtime', () => ({ controlCentralRuntime: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const runtime = {
  cwd: 'D:/workspace',
  cliPath: 'D:/trylo/main.js',
  process: {},
} as ToolLearningRuntime

it('keeps a first workspace without saved configuration inactive until an explicitly configured ordinary task', async () => {
  vi.mocked(controlCentralRuntime).mockResolvedValueOnce({ enabled: false })
  render(<CentralRuntimeStatus runtime={runtime} />)
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(true)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('尚未启用'))
  expect(screen.getByRole('status').textContent).toContain('可恢复配置')
  expect(screen.getByText(/勾选.*保存.*下次普通任务/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(true)
  expect(controlCentralRuntime).toHaveBeenCalledTimes(1)
})

it('shows CLI-origin activation and stops it directly without a business run or settings submit', async () => {
  const configuration = {
    providerId: 'saved',
    model: 'saved-model',
    endpointHash: 'saved',
    userLearning: false,
    allowance: { maxTokens: 32000 },
    thoughtMaxTokens: 64000,
  }
  vi.mocked(controlCentralRuntime)
    .mockResolvedValueOnce({
      enabled: true,
      owner: { ownerId: 'scope', state: 'waiting', revision: 1 },
      configuration,
    })
    .mockResolvedValueOnce({
      enabled: false,
      owner: { ownerId: 'scope', state: 'stopping', revision: 2 },
    })
    .mockResolvedValueOnce({ enabled: false, configuration })
    .mockResolvedValueOnce({
      enabled: true,
      owner: { ownerId: 'scope', state: 'waiting', revision: 3 },
    })
    .mockResolvedValueOnce({ enabled: false })
  const onEnabledChange = vi.fn()
  const view = render(<CentralRuntimeStatus runtime={runtime} onEnabledChange={onEnabledChange} />)
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('等待有意义的继续机会'),
  )
  expect(screen.getByText(/已有 CLI 授权/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '停止工作区学习' }))
  await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(false))
  expect(vi.mocked(controlCentralRuntime).mock.calls[1]?.[1]).toBe('stop')
  expect(screen.getByRole('status').textContent).toContain('正在停止')
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/后台连接/).textContent).toContain('saved-model')
  expect(controlCentralRuntime).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '刷新运行状态' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('学习已停止'))
  expect(vi.mocked(controlCentralRuntime).mock.calls[2]?.[1]).toBe('inspect')
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '恢复已有学习' }))
  await waitFor(() => expect(onEnabledChange).toHaveBeenLastCalledWith(true))
  expect(vi.mocked(controlCentralRuntime).mock.calls[3]?.[1]).toBe('resume')
  expect(screen.getByRole('status').textContent).toContain('等待有意义的继续机会')
  expect(screen.getByText(/后台连接/).textContent).toContain('saved-model')
  expect(controlCentralRuntime).toHaveBeenCalledTimes(4)
  view.rerender(
    <CentralRuntimeStatus
      runtime={{ ...runtime, cwd: 'D:/fresh-workspace' }}
      onEnabledChange={onEnabledChange}
    />,
  )
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('尚未启用'))
  expect(screen.queryByText(/后台连接/)).toBeNull()
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(true)
  expect(controlCentralRuntime).toHaveBeenCalledTimes(5)
})

it('retains the actual enabled status when a stop request is unconfirmed', async () => {
  vi.mocked(controlCentralRuntime)
    .mockResolvedValueOnce({ enabled: true })
    .mockRejectedValueOnce(new Error('runtime_owner_busy'))
    .mockResolvedValueOnce({ enabled: false })
  render(<CentralRuntimeStatus runtime={runtime} />)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已启用学习'))
  fireEvent.click(screen.getByRole('button', { name: '停止工作区学习' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('未确认'))
  expect(screen.getByRole('status').textContent).toContain('已启用学习')
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '停止工作区学习' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('学习已停止'))
  expect(screen.getByRole('status').textContent).toContain('未读到可恢复配置')
  expect(screen.getByRole('status').textContent).not.toContain('尚未启用')
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(true)
  expect(controlCentralRuntime).toHaveBeenCalledTimes(3)
})

it('reads an equivalent runtime once and delivers its result to the latest callback', async () => {
  let complete!: (state: CentralRuntimeState) => void
  vi.mocked(controlCentralRuntime).mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve
    }),
  )
  const first = vi.fn(),
    latest = vi.fn()
  const view = render(<CentralRuntimeStatus runtime={runtime} onState={first} />)
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(true)
  view.rerender(<CentralRuntimeStatus runtime={{ ...runtime }} onState={latest} />)
  expect(controlCentralRuntime).toHaveBeenCalledTimes(1)
  const state = { enabled: true }
  await act(async () => {
    complete(state)
  })
  expect(first).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledWith(state)
  expect(controlCentralRuntime).toHaveBeenCalledTimes(1)
})

it('ignores an aborted inspection after the workspace changes or the component unmounts', async () => {
  let oldComplete!: (state: CentralRuntimeState) => void
  vi.mocked(controlCentralRuntime)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        oldComplete = resolve
      }),
    )
    .mockResolvedValueOnce({ enabled: false })
  const first = vi.fn(),
    latest = vi.fn()
  const view = render(<CentralRuntimeStatus runtime={runtime} onState={first} />)
  view.rerender(
    <CentralRuntimeStatus runtime={{ ...runtime, cwd: 'D:/another-workspace' }} onState={latest} />,
  )
  await waitFor(() => expect(latest).toHaveBeenCalledWith({ enabled: false }))
  expect(vi.mocked(controlCentralRuntime).mock.calls[0]?.[2]?.aborted).toBe(true)
  await act(async () => {
    oldComplete({ enabled: true })
  })
  expect(first).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('status').textContent).toContain('尚未启用')
  expect(screen.getByRole('button', { name: '恢复已有学习' }).hasAttribute('disabled')).toBe(true)
  let lateComplete!: (state: CentralRuntimeState) => void
  vi.mocked(controlCentralRuntime).mockReturnValueOnce(
    new Promise((resolve) => {
      lateComplete = resolve
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: '刷新运行状态' }))
  view.unmount()
  await act(async () => {
    lateComplete({ enabled: true })
  })
  expect(latest).toHaveBeenCalledTimes(1)
})
