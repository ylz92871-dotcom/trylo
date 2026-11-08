import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserToolSidebar, browserSidebarPhase } from './BrowserToolSidebar'
import type { BrowserPreviewController } from '../../tooling/use-browser-preview'
import type { ToolPreviewState } from '../../tooling/tool-preview-state'

class ResizeFixture { observe(): void {} disconnect(): void {} }
beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeFixture) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const state: ToolPreviewState = { title: '浏览器', status: '执行中', detail: '', hasStarted: true, active: true, action: { id: 'step', title: '点击', target: '保存', status: '执行中' } }

it('offers fixed viewport controls without resizing the panel or changing webpage zoom', async () => {
  const setPageViewport = vi.fn(async () => {});
  const preview = { ...controller(), setPageViewport };
  render(<BrowserToolSidebar state={state} preview={preview} width={480} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '页面显示设置' }))
  fireEvent.change(screen.getByLabelText('页面尺寸模式'), { target: { value: 'desktop' } });
  await waitFor(() => expect(setPageViewport).toHaveBeenCalledWith({ mode: 'fixed', width: 1440, height: 900 }));
  expect(preview.setZoom).not.toHaveBeenCalled();
});

it('shows the actual fixed dimensions and display scale with a route back to follow-panel', async () => {
  const setPageViewport = vi.fn(async () => {}), base = controller();
  const nativeState = { ...base.nativeState!, viewport: { mode: 'fixed' as const, width: 1440, height: 900, scale: 0.25 } };
  render(<BrowserToolSidebar state={state} preview={{ ...base, nativeState, setPageViewport }} width={480} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '页面显示设置' }))
  expect(screen.getByText('1440 × 900')).toBeTruthy(); expect(screen.getByText('展示 25%')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('页面尺寸模式'), { target: { value: 'panel' } });
  await waitFor(() => expect(setPageViewport).toHaveBeenCalledWith({ mode: 'panel' }));
});
function controller(over: Partial<BrowserPreviewController> = {}): BrowserPreviewController {
  return { scope: 'one', status: 'running', detail: '', url: 'https://page.test', frameSeq: 0, latestFrame: null, zoom: 1,
    nativeState: { ok: true, scope: 'one', state: 'running', detail: '', control: 'agent', inFlight: 0, activeLabel: 'view-one', tabs: [{ id: 'target-one', label: 'view-one', title: 'Page', url: 'https://page.test' }] },
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), navigate: vi.fn(async () => {}), input: vi.fn(async () => {}), setVisible: vi.fn(), setViewportSize: vi.fn(), setBounds: vi.fn(async () => {}), setZoom: vi.fn(async () => {}), takeControl: vi.fn(async () => {}), releaseControl: vi.fn(async () => {}), selectTab: vi.fn(async () => {}), createTab: vi.fn(async () => {}), ...over }
}
describe('native browser sidebar', () => {
  it('disables page size changes during an active tool and surfaces rejected custom dimensions', async () => {
    const base = controller(), setPageViewport = vi.fn(async () => { throw new Error('页面尺寸过大') })
    const { rerender } = render(<BrowserToolSidebar state={state} preview={{ ...base, nativeState: { ...base.nativeState!, inFlight: 1 }, setPageViewport }} width={480} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '页面显示设置' }))
    expect((screen.getByLabelText('页面尺寸模式') as HTMLSelectElement).disabled).toBe(true)
    rerender(<BrowserToolSidebar state={state} preview={{ ...base, setPageViewport }} width={480} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('页面尺寸模式'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('页面宽度'), { target: { value: '1600' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('页面尺寸过大'))
    expect(setPageViewport).toHaveBeenCalledWith({ mode: 'fixed', width: 1600, height: 900 })
  })
  it('shows the current action and control owner prominently above the page', () => {
    const { container } = render(<BrowserToolSidebar state={state} preview={controller()} width={480} running onClose={() => {}} />)
    const activity = container.querySelector('.browser-control[data-state="acting"]')!
    expect(activity.textContent).toContain('Trylo 正在操作浏览器')
    expect(activity.textContent).toContain('正在点击『保存』')
    expect(activity.querySelector('.browser-control__mark')).toBeTruthy()
    expect(container.querySelector('.browser-history')?.textContent).not.toContain('Trylo 正在操作浏览器')
    expect(activity.compareDocumentPosition(container.querySelector('.browser-tool-sidebar__picture')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '我来接管' })).toHaveLength(1)
  })
  it('does not repeat the assistant final answer in the browser footer', () => {
    const finalAnswer = '网页已经处理完毕，以下是详细的完整结果。'
    render(<BrowserToolSidebar state={{ ...state, active: false, settlement: { outcome: 'done', summary: finalAnswer } }} preview={controller()} width={480} onClose={() => {}} />)
    expect(screen.queryByText(finalAnswer)).toBeNull()
    expect(screen.getByRole('button', { name: /操作记录/ })).toBeTruthy()
  })
  it('shows an empty new-tab address without exposing the internal target marker', () => {
    render(<BrowserToolSidebar state={state} preview={controller({ url: 'about:blank#trylo-native-private-id' })} width={480} onClose={() => {}} />)
    expect((screen.getByRole('textbox', { name: '网页地址' }) as HTMLInputElement).value).toBe('')
    expect(screen.queryByText(/trylo-native-private-id/)).toBeNull()
  })
  it('never uses a bitmap as live browser content even if a legacy frame exists', () => {
    const preview = controller({ latestFrame: { data: 'legacy-data', deviceWidth: 1440, deviceHeight: 900, pageScaleFactor: 1 } })
    const { container } = render(<BrowserToolSidebar state={state} preview={preview} width={480} running onClose={() => {}} />)
    expect(container.querySelector('.browser-tool-sidebar__picture[data-native]')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: '我来接管' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '我来接管' }))
    expect(preview.takeControl).toHaveBeenCalledOnce()
  })
  it('distinguishes pending takeover from confirmed control and allows handing back', () => {
    const preview = controller()
    const { rerender } = render(<BrowserToolSidebar state={state} preview={{ ...preview, nativeState: { ...preview.nativeState!, control: 'pending', inFlight: 1 } }} width={480} onClose={() => {}} />)
    expect(screen.getByText('正在移交控制权')).toBeTruthy()
    expect(screen.queryByText('你正在操作浏览器')).toBeNull()
    rerender(<BrowserToolSidebar state={state} preview={{ ...preview, nativeState: { ...preview.nativeState!, control: 'user' } }} width={480} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '交回 Trylo' }))
    expect(preview.releaseControl).toHaveBeenCalledOnce()
  })
  it('states that the task still runs when only browser tool calls are held', () => {
    const preview = controller()
    render(<BrowserToolSidebar state={state} preview={{ ...preview, nativeState: { ...preview.nativeState!, control: 'user' } }} width={480} running onClose={() => {}} />)
    expect(screen.getByText('浏览器操作已暂停；智能体仍在运行')).toBeTruthy()
    expect(screen.getByText('你正在操作浏览器')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '交回 Trylo' })).toHaveLength(1)
    expect(screen.queryByText('正在点击『保存』')).toBeNull()
  })
  it('the shared zoom buttons invoke actual native page zoom and fullscreen remains reachable', () => {
    const preview = controller(), fullscreen = vi.fn()
    render(<BrowserToolSidebar state={state} preview={preview} width={480} onToggleFullscreen={fullscreen} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '页面显示设置' }))
    fireEvent.click(screen.getByRole('button', { name: '200%' }))
    expect(preview.setZoom).toHaveBeenCalledWith(2)
    expect(screen.queryByRole('group', { name: '画面缩放' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '浏览器全屏' }))
    expect(fullscreen).toHaveBeenCalledOnce()
  })
  it('uses the real native tab identity for selection and creation', () => {
    const preview = controller()
    render(<BrowserToolSidebar state={state} preview={preview} width={480} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Page' }))
    expect(preview.selectTab).toHaveBeenCalledWith('view-one')
    fireEvent.click(screen.getByRole('button', { name: '新建浏览器标签页' }))
    expect(preview.createTab).toHaveBeenCalledOnce()
  })
  it('routes address, history, reload and closing a native tab to the real controller', async () => {
    const navigation = vi.fn(async () => {}), closeTab = vi.fn(async () => {})
    const preview = controller({ navigation, closeTab })
    render(<BrowserToolSidebar state={state} preview={preview} width={480} onClose={() => {}} />)
    const address = screen.getByRole('textbox', { name: '网页地址' })
    fireEvent.change(address, { target: { value: 'example.test/path' } }); fireEvent.submit(address.closest('form')!)
    await waitFor(() => expect(preview.navigate).toHaveBeenCalledWith('https://example.test/path'))
    fireEvent.change(address, { target: { value: 'localhost:3000/page' } }); fireEvent.submit(address.closest('form')!)
    await waitFor(() => expect(preview.navigate).toHaveBeenCalledWith('http://localhost:3000/page'))
    fireEvent.click(screen.getByRole('button', { name: '网页后退' })); expect(navigation).toHaveBeenCalledWith('back')
    fireEvent.click(screen.getByRole('button', { name: '网页前进' })); expect(navigation).toHaveBeenCalledWith('forward')
    fireEvent.click(screen.getByRole('button', { name: '刷新网页' })); expect(navigation).toHaveBeenCalledWith('reload')
    fireEvent.click(screen.getByRole('button', { name: '关闭标签页：Page' })); expect(closeTab).toHaveBeenCalledWith('view-one')
  })
  it('failed actions remain visible without opening history after a later successful action', () => {
    const failed = { id: 'failed', title: '点击', target: '保存', status: '失败', error: '目标按钮已移除' }
    render(<BrowserToolSidebar state={{ ...state, actions: [failed, state.action!] }} preview={controller()} width={480} onClose={() => {}} />)
    expect(screen.getByRole('alert').textContent).toContain('目标按钮已移除')
    expect(screen.queryByRole('list', { name: '最近工具操作' })).toBeNull()
  })
  it('reports failed takeover and does not manufacture a success receipt', async () => {
    const preview = controller({ takeControl: vi.fn(async () => { throw new Error('接管请求失败') }) })
    render(<BrowserToolSidebar state={state} preview={preview} width={480} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '我来接管' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('接管请求失败'))
    expect(screen.queryByText('你正在操作浏览器')).toBeNull()
  })
  it('replay is read-only evidence and never forwards keyboard, wheel or pointer input', () => {
    const preview = controller()
    const { container } = render(<BrowserToolSidebar state={state} preview={preview} replay={{ step: { src: 'data:image/png;base64,AA==', receivedAt: 1 } }} width={480} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '查看画面' }))
    const image = container.querySelector('img')!
    expect(image.getAttribute('tabindex')).toBeNull()
    fireEvent.pointerDown(image, { clientX: 20, clientY: 20 }); fireEvent.keyDown(image, { key: 'a' }); fireEvent.wheel(image, { deltaY: 100 })
    expect(preview.input).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '回到实时' }))
    expect(container.querySelector('img')).toBeNull()
  })
})
describe('seven distinct browser phases', () => {
  it.each([
    ['idle', { hasStarted: false }, 'stopped'], ['connecting', {}, 'starting'],
    ['executing', { active: true }, 'running'], ['done', { hasStarted: true }, 'running'],
    ['disconnected', {}, 'error'], ['failed', { action: { id: 'f', title: '点击', target: '', status: '失败' } }, 'running'],
    ['stopped', { settlement: { outcome: 'interrupted', summary: '任务已停止' } }, 'running'],
  ] as const)('%s', (expected, projected, status) => {
    expect(browserSidebarPhase({ title: '浏览器', status: '', detail: '', ...projected }, status)).toBe(expected)
  })
})

it('keeps display controls behind a real disclosure and gives blank native tabs a readable title', () => {
  const preview = controller({ url: 'about:blank#trylo-native-private-id', nativeState: { ...controller().nativeState!, tabs: [{ id: 'blank', label: 'view-one', title: 'about:blank#trylo-native-private-id', url: 'about:blank#trylo-native-private-id' }] } })
  render(<BrowserToolSidebar state={{ title: '浏览器', status: '', detail: '', hasStarted: false }} preview={preview} width={480} onClose={() => {}} />)
  expect(screen.queryByLabelText('页面尺寸模式')).toBeNull()
  expect(screen.getByRole('tab', { name: '新标签页' })).toBeTruthy()
  expect(screen.queryByText(/trylo-native-private-id/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^输入网址$/ }))
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '网页地址' }))
  expect((screen.getByRole('button', { name: '我来接管' }) as HTMLButtonElement).disabled).toBe(true)
})
it('switches native tabs by keyboard using their real labels', () => {
  const base = controller(), preview = { ...base, nativeState: { ...base.nativeState!, tabs: [...base.nativeState!.tabs, { id: 'target-two', label: 'view-two', title: 'Second', url: 'https://second.test' }] } }
  render(<BrowserToolSidebar state={state} preview={preview} width={480} onClose={() => {}} />)
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Page' }), { key: 'ArrowRight' })
  expect(preview.selectTab).toHaveBeenCalledWith('view-two')
})

it('does not turn the latest successful summary into an error for a failure outside retained history', () => {
  const completed = { id: 'latest', title: '查看页面', target: '', status: '已完成' }
  render(<BrowserToolSidebar state={{ title: '浏览器', status: '已完成', detail: '页面检查已完成', hasStarted: true, active: false, action: completed, actions: [completed], stepCount: 10, settlement: { outcome: 'failed', summary: '' } }} preview={controller()} width={480} onClose={() => {}} />)
  expect(screen.getByRole('alert').textContent).toBe('较早的操作失败，详情可在对话中查看。')
  expect(screen.queryByText('页面检查已完成')).toBeNull()
  expect(screen.getByText('本轮有操作未完成')).toBeTruthy()
})

it('cancels a pending takeover through the existing controller without claiming user control', () => {
  const preview = controller();
  const { container } = render(<BrowserToolSidebar state={state} preview={{ ...preview, nativeState: { ...preview.nativeState!, control: 'pending', inFlight: 1 } }} width={480} running onClose={() => {}} />)
  expect(container.querySelector('.browser-control-frame__edge')?.getAttribute('data-state')).toBe('pending-control')
  fireEvent.click(screen.getByRole('button', { name: '取消接管' }))
  expect(preview.releaseControl).toHaveBeenCalledOnce()
  expect(preview.takeControl).not.toHaveBeenCalled()
  expect(screen.queryByText('你正在操作浏览器')).toBeNull()
})
it('a finished command in a running conversation waits without retaining its elapsed clock', () => {
  const completed = { id: 'done', title: '点击', target: '保存', status: '已完成', startedAt: Date.now() - 5000 }
  const { container } = render(<BrowserToolSidebar state={{ ...state, active: false, action: completed, actions: [completed] }} preview={controller()} width={480} running onClose={() => {}} />)
  expect(screen.getByText('等待下一步操作')).toBeTruthy()
  expect(container.querySelector('.browser-control__elapsed')).toBeNull()
  expect(container.querySelector('.browser-control-frame__edge')?.getAttribute('data-state')).toBe('waiting')
  expect(screen.getByRole('button', { name: '我来接管' })).toBeTruthy()
})

it('reapplies hidden native bounds when switching between blank tabs of the same scope', async () => {
  const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 500, y: 200, left: 500, top: 200, right: 980, bottom: 800, width: 480, height: 600, toJSON: () => ({}) })
  const preview = controller({ url: 'about:blank' })
  const first = { ...preview.nativeState!, activeLabel: 'blank-one', tabs: [{ id: 'one', label: 'blank-one', title: '', url: 'about:blank' }] }
  try {
    const { rerender } = render(<BrowserToolSidebar state={state} preview={{ ...preview, nativeState: first }} width={480} onClose={() => {}} />)
    await waitFor(() => expect(preview.setBounds).toHaveBeenCalledTimes(1))
    const second = { ...first, activeLabel: 'blank-two', tabs: [...first.tabs, { id: 'two', label: 'blank-two', title: '', url: 'about:blank' }] }
    rerender(<BrowserToolSidebar state={state} preview={{ ...preview, nativeState: second }} width={480} onClose={() => {}} />)
    await waitFor(() => expect(preview.setBounds).toHaveBeenCalledTimes(2))
    expect(preview.setBounds).toHaveBeenLastCalledWith({ x: 500, y: 200, width: 480, height: 600 }, false)
  } finally { box.mockRestore() }
})

it('hides a failed native document and offers working retry and address controls', async () => {
  const base = controller(), navigation = vi.fn(async () => {});
  const preview = { ...base, navigation, nativeState: { ...base.nativeState!, tabs: [{ ...base.nativeState!.tabs[0]!, navigationError: { url: 'https://qoder/', code: 'ERR_NAME_NOT_RESOLVED' } }] } };
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 400, top: 200, width: 480, height: 600, x: 400, y: 200, right: 880, bottom: 800, toJSON() {} });
  try {
    const view = render(<BrowserToolSidebar state={{ ...state, active: false }} preview={preview} width={480} onClose={() => {}} />);
    expect(screen.getByText('无法打开网页')).toBeTruthy();
    expect(screen.getByText(/找不到 qoder/)).toBeTruthy();
    expect(screen.queryByText(/较早的操作失败/)).toBeNull();
    await waitFor(() => expect(preview.setBounds).toHaveBeenLastCalledWith({ x: 400, y: 200, width: 480, height: 600 }, false));
    expect(view.container.querySelector('[data-native]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(navigation).toHaveBeenCalledWith('reload'));
    fireEvent.click(screen.getByRole('button', { name: '修改网址' }));
    expect(document.activeElement).toBe(screen.getByLabelText('网页地址'));
  } finally { bounds.mockRestore(); }
});
