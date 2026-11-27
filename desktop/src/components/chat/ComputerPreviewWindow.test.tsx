import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerPreviewSnapshot } from '../../host-adapter/computer-preview-window'
import { ComputerPreviewWindow } from './ComputerPreviewWindow'

const channel = vi.hoisted(() => ({
  receive: undefined as ((snapshot: ComputerPreviewSnapshot) => void) | undefined,
  off: vi.fn(),
}))
vi.mock('../../host-adapter/computer-preview-window', () => ({
  EMPTY_COMPUTER_PREVIEW: { title: '电脑控制', status: '等待工具操作', detail: '' },
  observeComputerPreview: vi.fn(async (receive: (snapshot: ComputerPreviewSnapshot) => void) => {
    channel.receive = receive
    return channel.off
  }),
}))
vi.mock('../../settings/appearance-store', () => ({ useAppearance: vi.fn() }))

class PreviewResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  channel.off.mockClear()
  vi.stubGlobal('ResizeObserver', PreviewResizeObserver)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const FRAME =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
function snapshot(overrides: Partial<ComputerPreviewSnapshot> = {}): ComputerPreviewSnapshot {
  return {
    title: '点击',
    status: '执行中',
    detail: '',
    streamState: 'running',
    scope: 'a',
    action: { id: 'current', title: '点击', target: '保存', status: '执行中' },
    actions: [{ id: 'previous', title: '打开应用', target: '笔记', status: '已完成' }],
    ...overrides,
  }
}
function publish(value: ComputerPreviewSnapshot): void {
  act(() => channel.receive?.(value))
}

describe('computer observation window', () => {
  it('idle keeps the operation line visible and history collapsed', () => {
    render(<ComputerPreviewWindow />)
    expect(screen.getByRole('status').textContent).toContain('等待电脑操作')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('最近操作 · 0')).toBeTruthy()
  })

  it('connecting displays the started operation before any frame or tool result', () => {
    render(<ComputerPreviewWindow />)
    publish(snapshot({ streamState: 'starting' }))
    expect(screen.getByRole('status').textContent).toContain('正在点击')
    expect(screen.getByText('正在连接电脑画面')).toBeTruthy()
  })

  it('running consumes successive frames from the existing channel', () => {
    const { container } = render(<ComputerPreviewWindow />)
    publish(snapshot({ dataUrl: FRAME }))
    expect(container.querySelector('.preview-image__stage img')?.getAttribute('src')).toBe(FRAME)
    publish(snapshot({ dataUrl: `${FRAME}#second-frame` }))
    expect(container.querySelector('.preview-image__stage img')?.getAttribute('src')).toBe(
      `${FRAME}#second-frame`,
    )
    expect(screen.getByRole('status').textContent).toContain('保存')
  })

  it('completion retains the picture and gives a completed action label', () => {
    render(<ComputerPreviewWindow />)
    publish(
      snapshot({
        dataUrl: FRAME,
        status: '已完成',
        streamState: 'stopped',
        action: { id: 'current', title: '点击', target: '保存', status: '已完成' },
      }),
    )
    expect(screen.getByRole('status').textContent).toContain('点击已完成')
    expect(screen.getByText('画面已保留', { selector: 'span' })).toBeTruthy()
  })

  it('preview disconnection shows its reason while the tool remains running', () => {
    render(<ComputerPreviewWindow />)
    publish(snapshot({ streamState: 'error', streamDetail: '画面通道断开' }))
    expect(screen.getByRole('alert').textContent).toContain('画面通道断开')
    expect(screen.getByRole('alert').textContent).toContain('工具仍在执行')
    expect(screen.getByRole('status').textContent).toContain('正在点击')
  })

  it('tool failure exposes its reason without opening history', () => {
    render(<ComputerPreviewWindow />)
    publish(snapshot({ status: '失败', detail: '未找到保存按钮' }))
    expect(screen.getByRole('status').textContent).toContain('点击失败')
    expect(screen.getByRole('status').textContent).toContain('未找到保存按钮')
    expect(screen.getByRole('button', { name: '最近操作 · 1' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('stopping overrides a stale running action and ends the activity animation', () => {
    const { container } = render(<ComputerPreviewWindow />)
    publish(snapshot({ dataUrl: FRAME, status: '已中断', streamState: 'stopped' }))
    expect(screen.getByRole('status').textContent).toContain('操作已中断')
    expect(container.querySelector('.preview-activity .preview-actions__spin')).toBeNull()
    expect(screen.getByText('画面已保留', { selector: 'span' })).toBeTruthy()
  })

  it('expanding history never repeats the current action or hides its line', () => {
    render(<ComputerPreviewWindow />)
    const value = snapshot()
    publish({ ...value, actions: [...(value.actions ?? []), value.action!] })
    fireEvent.click(screen.getByText('最近操作 · 1'))
    expect(screen.getByRole('list').textContent).toContain('打开应用')
    expect(screen.getByRole('list').textContent).not.toContain('保存')
    expect(screen.getByRole('status').textContent).toContain('正在点击')
  })

  it('a new scope clears the old picture, markers and expanded panels', () => {
    const { container } = render(<ComputerPreviewWindow />)
    publish(snapshot({ dataUrl: FRAME }))
    fireEvent.click(screen.getByText('最近操作 · 1'))
    fireEvent.click(screen.getByLabelText('画面与操作详情'))
    publish({ title: '电脑控制', status: '等待工具操作', detail: '', scope: 'b', actions: [] })
    expect(container.querySelector('.preview-image__stage img')).toBeNull()
    expect(container.querySelectorAll('details[open]').length).toBe(0)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('最近操作 · 0')).toBeTruthy()
    expect(screen.getByRole('button', { name: '最近操作 · 0' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('renders a virtual agent cursor overlay for background actions with normalized coordinates', () => {
    render(<ComputerPreviewWindow />)
    publish(
      snapshot({
        dataUrl: FRAME,
        frameGeometry: { width: 1000, height: 600, originX: 0, originY: 0 },
        action: {
          id: 'bg-press',
          title: '后台操作控件',
          target: 'AXPress',
          status: '执行中',
          startedAt: Date.now(),
          point: { x: 0.4, y: 0.6, space: 'normalized' },
        },
      }),
    )
    const virtualCursor = screen.getByLabelText('代理虚拟光标')
    expect(virtualCursor.style.left).toBe('40%')
    expect(virtualCursor.style.top).toBe('60%')
  })

  it('unmount only unsubscribes this observer', async () => {
    const { unmount } = render(<ComputerPreviewWindow />)
    await act(async () => {})
    unmount()
    await waitFor(() => expect(channel.off).toHaveBeenCalledOnce())
  })
})
