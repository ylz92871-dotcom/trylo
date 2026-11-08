import { describe, expect, it } from 'vitest'
import { browserActivityView } from './browser-activity-state'
import type { BrowserPreviewController } from '../../tooling/use-browser-preview'
import type { ToolPreviewState } from '../../tooling/tool-preview-state'
const action = { id: 'click', title: '点击', target: '保存', status: '执行中', startedAt: 1000, stepIndex: 3 }
const state: ToolPreviewState = { title: '浏览器', detail: '', status: '执行中', hasStarted: true, active: true, action }
function preview(control: 'agent' | 'user' | 'pending' = 'agent', inFlight = 0): BrowserPreviewController {
  return { scope: 'test', status: 'running', detail: '', url: 'https://example.test', frameSeq: 0, latestFrame: null, zoom: 1,
    nativeState: { ok: true, scope: 'test', state: 'running', detail: '', control, inFlight, activeLabel: 'one', tabs: [] },
    start: async () => {}, stop: async () => {}, navigate: async () => {}, input: async () => {}, setVisible: () => {}, setViewportSize: () => {}, setBounds: async () => {}, setZoom: async () => {}, takeControl: async () => {}, releaseControl: async () => {}, selectTab: async () => {}, createTab: async () => {} }
}
describe('browser operation truth', () => {
  it('shows a running command from tool events with its original target and start time', () => {
    const view = browserActivityView(state, preview(), true)
    expect(view).toMatchObject({ mode: 'acting', title: '正在点击『保存』', clocking: true, step: 3 })
    expect(view.action?.startedAt).toBe(1000)
  })
  it('stops the old command clock while the conversation continues between browser commands', () => {
    const view = browserActivityView({ ...state, active: false, action: { ...action, status: '已完成', durationMs: 2500 } }, preview(), true)
    expect(view).toMatchObject({ phase: 'waiting', mode: 'waiting', title: '等待下一步', clocking: false })
  })
  it('does not claim a browser operation just because a conversation is running', () => {
    expect(browserActivityView({ title: '浏览器', status: '', detail: '', hasStarted: false }, preview(), true).mode).toBe('idle')
  })
  it('distinguishes queued work from a command actually in flight', () => {
    const queued = { ...state, action: { ...action, status: '待执行' } }
    expect(browserActivityView(queued, preview(), true)).toMatchObject({ mode: 'queued', clocking: false })
    expect(browserActivityView(queued, preview('agent', 1), true).mode).toBe('acting')
  })
  it('keeps takeover pending until the controller confirms user ownership', () => {
    expect(browserActivityView(state, preview('pending', 1), true)).toMatchObject({ mode: 'pending-control', owner: '等待当前操作结束' })
    expect(browserActivityView(state, preview('user'), true)).toMatchObject({ mode: 'user-control', owner: '你已接管', title: '等待交回控制权', clocking: false })
  })
  it('keeps historical evidence static while a different live command runs', () => {
    const old = { ...action, id: 'old', status: '已完成', durationMs: 500 }
    expect(browserActivityView(state, preview(), true, old)).toMatchObject({ mode: 'replay', title: '点击『保存』', clocking: false, action: old })
  })
  it('uses the failed operation rather than relabeling a later successful operation', () => {
    const failed = { ...action, id: 'failed', status: '失败', error: '目标已移除' }
    const success = { ...action, id: 'success', status: '已完成', title: '查看页面' }
    const view = browserActivityView({ ...state, active: false, action: success, actions: [failed, success], settlement: { outcome: 'failed', summary: '' } }, preview(), false)
    expect(view).toMatchObject({ mode: 'failed', action: failed, title: '点击『保存』' })
  })
  it('does not invent a failed target if the older command is outside retained history', () => {
    expect(browserActivityView({ ...state, active: false, action: { ...action, status: '已完成' }, actions: [], settlement: { outcome: 'failed', summary: '' } }, preview(), false)).toMatchObject({ mode: 'failed', action: undefined, title: '本轮有操作未完成' })
  })
  it('shows disconnection over stale control state and keeps stopped distinct from failure', () => {
    expect(browserActivityView(state, { ...preview('user'), status: 'error' }, true).mode).toBe('disconnected')
    expect(browserActivityView({ ...state, active: false, settlement: { outcome: 'interrupted', summary: '' } }, preview(), false).mode).toBe('stopped')
  })
})

it('does not relabel the last completed action when only the native in-flight receipt has arrived', () => {
  const state: ToolPreviewState = { title: '浏览器', status: '已完成', detail: '', hasStarted: true, active: false, action: { id: 'old', title: '点击', target: '旧按钮', status: '已完成', durationMs: 300 } }
  const controller = { status: 'running', nativeState: { inFlight: 1, control: 'agent' } } as BrowserPreviewController
  expect(browserActivityView(state, controller, true)).toMatchObject({ mode: 'acting', title: '正在操作网页', step: undefined, clocking: false })
})
