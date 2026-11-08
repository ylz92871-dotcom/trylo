import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBrowserPreview } from './use-browser-preview'
import type { ToolingFacade } from './tooling-facade'
import type { ServiceManager, ServiceHealth } from '../services-host/service-manager'
import type { NativeBrowserState } from '../services-host/methods'
import { nativeBrowserCommand, onNativeBrowserControls, onNativeBrowserPage, type NativeBrowserControlsEvent, type NativeBrowserPageEvent } from '../host-adapter/native-browser'

vi.mock('../host-adapter/native-browser', () => ({
  nativeBrowserScope: (root: string, id: string) => JSON.stringify([root.replaceAll('\\', '/').toLowerCase(), id]),
  nativeBrowserCommand: vi.fn(async () => ({ scope: '["d:/task","one"]', cdpPort: 9000, tabs: [], activeLabel: 'one' })),
  onNativeBrowserPage: vi.fn(async () => () => {}),
  onNativeBrowserControls: vi.fn(async () => () => {}),
}))
afterEach(() => { vi.clearAllMocks() })
function fixture() {
  const events = new Map<string, (data: unknown) => void>()
  let health: (value: ServiceHealth) => void = () => {}
  const state: NativeBrowserState = { nativeLayout: 'direct', ok: true, scope: '["d:/task","one"]', state: 'running', detail: '', control: 'agent', inFlight: 0, activeLabel: 'one', tabs: [{ id: 'real-target', label: 'one', title: 'Page', url: 'https://page.test' }] }
  const open = vi.fn(async () => state)
  const control = vi.fn(async (_scope: string, held: boolean): Promise<NativeBrowserState> => ({ ...state, control: held ? 'pending' : 'agent', inFlight: held ? 1 : 0 }))
  const layout = vi.fn(async (_scope: string, _bounds: unknown, _visible: boolean) => state)
  const viewport = vi.fn(async (_scope: string, _label: string, _viewport: unknown) => state)
  const facade = { nativeBrowserLayout: layout, nativeBrowserViewport: viewport, connectNativeBridge: () => () => {}, nativeBrowserOpen: open, nativeBrowserControl: control, nativeBrowserState: vi.fn(async () => state), nativeBrowserSelect: vi.fn(async () => state), nativeBrowserCreate: vi.fn(async () => state) } as unknown as ToolingFacade
  const manager = { currentHealth: 'starting', onHealth: (fn: typeof health) => { health = fn; return () => {} }, client: { onEvent: (name: string, fn: (data: unknown) => void) => { events.set(name, fn); return () => events.delete(name) } } } as unknown as ServiceManager
  return { facade, manager, open, control, layout, viewport, events, state, ready: () => health('ready'), setHealth: (value: ServiceHealth) => health(value) }
}
describe('native browser controller', () => {
  it('uses one viewport owner and ignores a late older layout snapshot', async () => {
    const f = fixture()
    const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }))
    act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('running'))
    const fixed = { ...f.state, revision: 10, viewport: { mode: 'fixed' as const, width: 1440, height: 900, scale: .25 } }
    f.viewport.mockResolvedValueOnce(fixed)
    await act(() => result.current.setPageViewport!({ mode: 'fixed', width: 1440, height: 900 }))
    expect(f.viewport).toHaveBeenCalledWith(f.state.scope, 'one', { mode: 'fixed', width: 1440, height: 900 })
    act(() => f.events.get('tooling.nativeBrowserState')?.({ ...f.state, revision: 9 }))
    expect(result.current.nativeState?.viewport).toEqual(fixed.viewport)
    await expect(result.current.setZoom(2)).rejects.toThrow('固定页面尺寸')
  })
  it('coalesces a rapid drag while native geometry is awaiting its own receipt', async () => {
    const f = fixture();
    const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }));
    act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('running'));
    let finish = () => {};
    vi.mocked(nativeBrowserCommand).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ scope: f.state.scope, cdpPort: 9000, activeLabel: 'one', tabs: [] }); }));
    const first = result.current.setBounds({ x: 700, y: 100, width: 320, height: 600 }, true);
    await waitFor(() => expect(nativeBrowserCommand).toHaveBeenCalledWith(expect.objectContaining({ bounds: expect.objectContaining({ width: 320 }) })));
    const drag = Array.from({ length: 120 }, (_, index) => result.current.setBounds({ x: 700, y: 100, width: 321 + index, height: 600 }, true));
    finish(); await act(async () => { await Promise.all([first, ...drag]); });
    expect(vi.mocked(nativeBrowserCommand).mock.calls.filter(([command]) => command.operation === 'layout').map(([command]) => command.bounds?.width)).toEqual([320, 440]);
    await waitFor(() => expect(f.layout).toHaveBeenLastCalledWith(f.state.scope, expect.objectContaining({ width: 440 }), true, true));
  });
  it('does not overwrite a recovered connection with an old startup timeout', async () => {
    const f = fixture()
    let rejectOld: (error: Error) => void = () => {}
    f.open.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
    const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }))
    act(() => f.ready())
    await waitFor(() => expect(f.open).toHaveBeenCalledTimes(1))
    act(() => f.setHealth('restarting'))
    expect(result.current.status).toBe('error')
    act(() => f.ready())
    await waitFor(() => expect(result.current.status).toBe('running'))
    expect(f.open).toHaveBeenCalledTimes(2)
    await act(async () => { rejectOld(new Error('service host request timed out after 60000ms')); await Promise.resolve() })
    expect(result.current.status).toBe('running')
    expect(result.current.detail).toBe('')
  })
  it.each(['success', 'failure'] as const)('ignores an old page read %s after a same-scope host restart', async outcome => {
    let page: (event: NativeBrowserPageEvent) => void = () => {}
    vi.mocked(onNativeBrowserPage).mockImplementationOnce(async handler => { page = handler; return () => {} })
    const f = fixture()
    const { result } = renderHook(() => useBrowserPreview({
      facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one',
    }))
    act(() => f.ready())
    await waitFor(() => expect(result.current.status).toBe('running'))
    let resolveOld: (state: NativeBrowserState) => void = () => {}
    let rejectOld: (error: Error) => void = () => {}
    vi.mocked(f.facade.nativeBrowserState).mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveOld = resolve; rejectOld = reject
    }))
    act(() => page({ scope: f.state.scope, label: 'one' }))
    await waitFor(() => expect(f.facade.nativeBrowserState).toHaveBeenCalledTimes(1))
    act(() => f.setHealth('restarting'))
    f.open.mockResolvedValueOnce({ ...f.state, revision: 1 })
    act(() => f.ready())
    await waitFor(() => expect(f.open).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.status).toBe('running'))
    await act(async () => {
      if (outcome === 'success') resolveOld({ ...f.state, revision: 100, state: 'error', detail: 'old host disconnected' })
      else rejectOld(new Error('old host page read failed'))
      await Promise.resolve()
    })
    expect(result.current.status).toBe('running')
    expect(result.current.detail).toBe('')
    expect(result.current.nativeState?.revision).toBe(1)
    act(() => f.events.get('tooling.nativeBrowserState')?.({
      ...f.state, revision: 2, tabs: [{ ...f.state.tabs[0]!, url: 'https://recovered.test' }],
    }))
    expect(result.current.url).toBe('https://recovered.test')
  })
  it.each(['panel', 'fixed'] as const)('ignores an old %s zoom snapshot after a same-scope host restart', async mode => {
    let notify: (event: NativeBrowserControlsEvent) => void = () => {}
    vi.mocked(onNativeBrowserControls).mockImplementationOnce(async handler => { notify = handler; return () => {} })
    const f = fixture()
    const fixed = { mode: 'fixed' as const, width: 1440, height: 900, scale: 1 }
    f.open.mockResolvedValueOnce({ ...f.state, revision: 20, ...(mode === 'fixed' ? { viewport: fixed } : {}) })
    const { result } = renderHook(() => useBrowserPreview({
      facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one',
    }))
    act(() => f.ready())
    await waitFor(() => expect(result.current.status).toBe('running'))
    let resolveOld: (state: NativeBrowserState) => void = () => {}
    const pendingOld = new Promise<NativeBrowserState>(resolve => { resolveOld = resolve })
    const read = mode === 'fixed' ? f.viewport : vi.mocked(f.facade.nativeBrowserState)
    read.mockImplementationOnce(() => pendingOld)
    act(() => notify({ scope: f.state.scope, label: 'one', zoom: 2 }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    act(() => f.setHealth('restarting'))
    f.open.mockResolvedValueOnce({ ...f.state, revision: 1 })
    act(() => f.ready())
    await waitFor(() => expect(f.open).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.status).toBe('running'))
    await act(async () => {
      resolveOld({ ...f.state, revision: 100, state: 'error', detail: 'old zoom host disconnected' })
      await Promise.resolve()
    })
    expect(result.current.status).toBe('running')
    expect(result.current.detail).toBe('')
    expect(result.current.nativeState?.revision).toBe(1)
    act(() => f.events.get('tooling.nativeBrowserState')?.({
      ...f.state, revision: 2, tabs: [{ ...f.state.tabs[0]!, url: 'https://zoom-recovered.test' }],
    }))
    expect(result.current.url).toBe('https://zoom-recovered.test')
  })
  it.each(['close', 'zoom', 'take', 'release', 'select', 'create'] as const)(
    'ignores an old %s action snapshot after a same-scope host restart', async action => {
      const f = fixture()
      const { result } = renderHook(() => useBrowserPreview({
        facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one',
      }))
      act(() => f.ready())
      await waitFor(() => expect(result.current.status).toBe('running'))
      let resolveOld: (state: NativeBrowserState) => void = () => {}
      const pendingOld = new Promise<NativeBrowserState>(resolve => { resolveOld = resolve })
      const read = action === 'close' || action === 'zoom' ? vi.mocked(f.facade.nativeBrowserState)
        : action === 'take' || action === 'release' ? f.control
          : action === 'select' ? vi.mocked(f.facade.nativeBrowserSelect) : vi.mocked(f.facade.nativeBrowserCreate)
      read.mockImplementationOnce(() => pendingOld)
      const operation = action === 'close' ? result.current.closeTab!('one')
        : action === 'zoom' ? result.current.setZoom(2)
          : action === 'take' ? result.current.takeControl()
            : action === 'release' ? result.current.releaseControl()
              : action === 'select' ? result.current.selectTab('one') : result.current.createTab()
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      act(() => f.setHealth('restarting'))
      f.open.mockResolvedValueOnce({ ...f.state, revision: 1 })
      act(() => f.ready())
      await waitFor(() => expect(f.open).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(result.current.status).toBe('running'))
      await act(async () => {
        resolveOld({ ...f.state, revision: 100, state: 'error', detail: 'old action host disconnected' })
        await operation
      })
      expect(result.current.status).toBe('running')
      expect(result.current.detail).toBe('')
      expect(result.current.nativeState?.revision).toBe(1)
      act(() => f.events.get('tooling.nativeBrowserState')?.({
        ...f.state, revision: 2, tabs: [{ ...f.state.tabs[0]!, url: 'https://action-recovered.test' }],
      }))
      expect(result.current.url).toBe('https://action-recovered.test')
    })
  it('connects a native session after service readiness and never exposes a live bitmap', async () => {
    const f = fixture()
    const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }))
    expect(f.open).not.toHaveBeenCalled()
    act(() => f.ready())
    await waitFor(() => expect(result.current.status).toBe('running'))
    expect(f.open).toHaveBeenCalledWith({ projectRoot: 'D:/task', conversationId: 'one' })
    expect(result.current.latestFrame).toBeNull()
    expect(result.current.url).toBe('https://page.test')
    await expect(result.current.input({ kind: 'mouse', x: .5, y: .5 })).rejects.toThrow('直接接收输入')
  })
  it('does not declare takeover until the service says the active tool has drained', async () => {
    const f = fixture()
    const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }))
    act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('running'))
    await act(() => result.current.takeControl())
    expect(f.control).toHaveBeenCalledWith(f.state.scope, true)
    expect(result.current.nativeState?.control).toBe('pending')
    act(() => f.events.get('tooling.nativeBrowserState')?.({ ...f.state, control: 'user' }))
    expect(result.current.nativeState?.control).toBe('user')
    await act(() => result.current.releaseControl())
    expect(f.control).toHaveBeenLastCalledWith(f.state.scope, false)
  })
  it('uses CSS bounds and native engine zoom, and hides without stopping MCP or destroying tabs', async () => {
    const f = fixture()
    const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }))
    act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('running'))
    const bounds = { x: 800, y: 70, width: 480, height: 640 }
    await act(() => result.current.setBounds(bounds, true))
    expect(f.layout).toHaveBeenCalledWith(f.state.scope, bounds, true, true)
    await act(() => result.current.setZoom(2))
    expect(nativeBrowserCommand).toHaveBeenCalledWith({ scope: f.state.scope, operation: 'zoom', zoom: 2 })
    expect(result.current.zoom).toBe(2)
    await act(() => result.current.stop())
    expect(f.layout).toHaveBeenCalledWith(f.state.scope, undefined, false, true)
    expect(result.current.nativeState?.tabs).toHaveLength(1)
  })
  it('rejects stale conversation events and hides the old native view on a switch', async () => {
    let page: (event: NativeBrowserPageEvent) => void = () => {}
    vi.mocked(onNativeBrowserPage).mockImplementationOnce(async handler => { page = handler; return () => {} })
    const f = fixture()
    const { result, rerender } = renderHook(({ id }) => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: id }), { initialProps: { id: 'one' } })
    act(() => f.ready()); await waitFor(() => expect(result.current.url).toBe('https://page.test'))
    let rejectOld: (error: Error) => void = () => {}
    vi.mocked(f.facade.nativeBrowserState).mockImplementationOnce(() => new Promise<NativeBrowserState>((_resolve, reject) => { rejectOld = reject }))
    act(() => page({ scope: f.state.scope, label: 'one' }))
    rerender({ id: 'two' })
    await waitFor(() => expect(f.layout).toHaveBeenCalledWith(f.state.scope, undefined, false, true))
    act(() => f.events.get('tooling.nativeBrowserState')?.({ ...f.state, control: 'user', tabs: [{ ...f.state.tabs[0]!, url: 'https://stale.test' }] }))
    expect(result.current.url).not.toBe('https://stale.test')
    await act(async () => { rejectOld(new Error('old browser read failed')); await Promise.resolve() })
    expect(result.current.detail).not.toBe('old browser read failed')
  })
  it('does not show an old conversation when its queued layout finishes after switching', async () => {
    const f = fixture()
    const { result, rerender } = renderHook(({ id }) => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: id }), { initialProps: { id: 'one' } })
    act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('running'))
    let finish: () => void = () => {}
    f.layout.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(f.state) }))
    const first = result.current.setBounds({ x: 800, y: 70, width: 480, height: 640 }, true)
    await waitFor(() => expect(f.layout).toHaveBeenCalledWith(f.state.scope, expect.objectContaining({ x: 800 }), true, true))
    const late = result.current.setBounds({ x: 900, y: 70, width: 480, height: 640 }, true)
    rerender({ id: 'two' }); finish()
    await act(async () => { await first; await late })
    expect(f.layout).not.toHaveBeenCalledWith(f.state.scope, expect.objectContaining({ x: 900 }), true, true)
    await waitFor(() => expect(f.layout).toHaveBeenCalledWith(f.state.scope, undefined, false, true))
  })
  it('surfaces native startup failure without falling back to screenshot preview', async () => {
    const f = fixture(); f.open.mockRejectedValueOnce(new Error('native host unavailable'))
    const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }))
    act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.detail).toBe('native host unavailable')
    expect(result.current.latestFrame).toBeNull()
  })
  it('tracks native shortcut zoom and Escape while ignoring another tab or conversation', async () => {
    let notify: (event: NativeBrowserControlsEvent) => void = () => {}
    vi.mocked(onNativeBrowserControls).mockImplementationOnce(async handler => { notify = handler; return () => {} })
    const f = fixture(), escape = vi.fn()
    window.addEventListener('trylo:exit-browser-fullscreen', escape)
    const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }))
    act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('running'))
    act(() => notify({ scope: f.state.scope, label: 'one', zoom: 2 }))
    expect(result.current.zoom).toBe(2)
    act(() => notify({ scope: f.state.scope, label: 'background-tab', zoom: 1, key: 'Escape' }))
    act(() => notify({ scope: 'another-conversation', label: 'one', zoom: 1, key: 'Escape' }))
    expect(result.current.zoom).toBe(2); expect(escape).not.toHaveBeenCalled()
    act(() => notify({ scope: f.state.scope, label: 'one', key: 'Escape' }))
    expect(escape).toHaveBeenCalledOnce()
    window.removeEventListener('trylo:exit-browser-fullscreen', escape)
  })
})

it('moves native bounds again while a previous page measurement is still pending', async () => {
  const f = fixture();
  const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }));
  act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('running'));
  let finish = () => {};
  f.layout.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(f.state); }));
  const first = result.current.setBounds({ x: 700, y: 100, width: 320, height: 600 }, true);
  try {
    await waitFor(() => expect(f.layout).toHaveBeenCalled());
    const next = result.current.setBounds({ x: 420, y: 100, width: 600, height: 600 }, true);
    await waitFor(() => expect(nativeBrowserCommand).toHaveBeenCalledWith(expect.objectContaining({ operation: 'layout', bounds: expect.objectContaining({ x: 420, width: 600 }) })));
    await next;
  } finally { finish(); await act(async () => { await first; }); }
});

it('keeps the legacy ordering when an older running host has not advertised direct geometry', async () => {
  const f = fixture(); f.open.mockResolvedValueOnce({ ...f.state, nativeLayout: undefined });
  const { result } = renderHook(() => useBrowserPreview({ facade: f.facade, serviceManager: f.manager, projectRoot: 'D:/task', conversationId: 'one' }));
  act(() => f.ready()); await waitFor(() => expect(result.current.status).toBe('running'));
  const bounds = { x: 700, y: 100, width: 320, height: 600 };
  await act(() => result.current.setBounds(bounds, true));
  expect(f.layout).toHaveBeenCalledWith(f.state.scope, bounds, true);
  expect(nativeBrowserCommand).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'layout', bounds }));
});
