import { describe, expect, it } from 'vitest'
import { previewKind, toolPreviewState } from './tool-preview-state'
import type { ChatMessage, ToolMessage } from '../components/chat/types'
import type { BinaryRef } from './tool-result-content'

const ref: BinaryRef = {
  id: 'screen',
  storage: 'ephemeral-tool-cache',
  path: '/cache/shot.png',
  mimeType: 'image/png',
  size: 20,
  sha256: 'digest',
}
const screenshot: ToolMessage = {
  id: 's',
  role: 'assistant',
  kind: 'tool',
  createdAt: 10,
  tool: 'mcp__trylo-windows__Screenshot',
  status: 'done',
  summary: '窗口截图',
  outputContent: [{ type: 'image', ref }],
}
const click: ToolMessage = {
  ...screenshot,
  id: 'c',
  createdAt: 20,
  tool: 'mcp__trylo-windows__Click',
  status: 'running',
  summary: '点击按钮',
  outputContent: undefined,
}
describe('tool preview projection', () => {
  it('a real cancellation receipt settles a browser task as stopped even after its last tool finished', () => {
    const user: ChatMessage = { id: 'current-user', kind: 'text', role: 'user', createdAt: 1, text: '浏览网页' }
    const browser: ToolMessage = { ...screenshot, tool: 'mcp__trylo-browser__browser_navigate', input: { url: 'https://page.test' } }
    const notice: ChatMessage = { id: 'run-cancelled:real-run', kind: 'notice', role: 'system', createdAt: 30, turnId: user.id, text: '任务已被手动停止' }
    expect(toolPreviewState([user, browser, notice], 'browser', { running: false }).settlement).toEqual({ outcome: 'interrupted', summary: notice.text })
    expect(toolPreviewState([user, browser, { ...notice, turnId: 'previous-user' }], 'browser', { running: false }).settlement?.outcome).toBe('done')
  })
  it('follows status while retaining the actual previous screenshot in the same turn', () => {
    expect(toolPreviewState([screenshot, click], 'computer')).toMatchObject({
      status: '执行中',
      detail: '点击按钮',
      image: ref,
      screenshotAt: 10,
    })
  })
  it('clears old screenshots when the user starts a new task', () => {
    const next: ChatMessage = { id: 'u', kind: 'text', role: 'user', createdAt: 30, text: '新任务' }
    expect(toolPreviewState([screenshot, next], 'computer').image).toBeUndefined()
    expect(toolPreviewState([screenshot, next], 'computer').status).toBe('等待工具操作')
  })
  it('does not clear the current task for a delivered steer', () => {
    const steer: ChatMessage = {
      id: 'u',
      kind: 'text',
      role: 'user',
      createdAt: 30,
      text: '继续',
      steerState: 'delivered',
    }
    expect(toolPreviewState([screenshot, steer], 'computer').image).toBe(ref)
  })
  it('separates browser and computer tools and ignores ordinary terminal tools', () => {
    expect(previewKind('mcp__trylo-chrome__take_screenshot')).toBe('browser')
    expect(previewKind('mcp__trylo-browser__browser_snapshot')).toBe('browser')
    expect(previewKind('mcp__trylo-macos__ax_perform')).toBe('computer')
    expect(previewKind('Bash')).toBeNull()
    expect(toolPreviewState([screenshot], 'browser').image).toBeUndefined()
  })
  it('projects macOS background computer actions and normalized virtual cursor coordinates without leaking sensitive values', () => {
    const perform: ToolMessage = {
      ...click,
      id: 'mac-ax',
      tool: 'mcp__trylo-macos__ax_perform',
      input: { pid: 55, path: [0, 1], action: 'AXPress' },
      outputText: JSON.stringify({ performed: true, normalizedPoint: { x: 0.35, y: 0.6 } }),
      summary: '后台点击按钮',
    }
    const setValue: ToolMessage = {
      ...click,
      id: 'mac-val',
      createdAt: 30,
      tool: 'mcp__trylo-macos__ax_set_value',
      input: { pid: 55, path: [0, 2], value: 'private-secret' },
      summary: '后台写入输入框',
    }
    const findControl: ToolMessage = {
      ...click,
      id: 'mac-find',
      createdAt: 40,
      tool: 'mcp__trylo-macos__ax_find',
      input: { pid: 55, query: 'Save' },
      summary: '查找保存按钮',
    }
    expect(toolPreviewState([perform], 'computer')).toMatchObject({
      hasTools: true,
      active: true,
      action: { title: '后台操作控件', target: 'AXPress', status: '执行中', point: { x: 0.35, y: 0.6, space: 'normalized' } },
    })
    expect(toolPreviewState([setValue], 'computer')).toMatchObject({
      action: { title: '后台写入控件', target: '' },
    })
    expect(toolPreviewState([findControl], 'computer')).toMatchObject({
      action: { title: '查找后台控件' },
    })
  })
  it('surfaces errors without inventing a new screenshot', () => {
    expect(
      toolPreviewState([{ ...click, status: 'error', outputError: '目标已关闭' }], 'computer'),
    ).toMatchObject({ status: '失败', detail: '目标已关闭', image: undefined })
  })
  it('associates an image read with the screenshot file the browser tool actually created', () => {
    const shot: ToolMessage = { ...screenshot, tool: 'mcp__trylo-browser__browser_take_screenshot', input: { filename: 'page.png' }, outputContent: undefined }
    const read: ToolMessage = { ...screenshot, id: 'r', tool: 'Read', input: { file_path: '/task/page.png' } }
    expect(toolPreviewState([shot, read], 'browser').image).toBe(ref)
    expect(toolPreviewState([shot, { ...read, input: { file_path: '/task/other.png' } }], 'browser').image).toBeUndefined()
    expect(toolPreviewState([read], 'browser').image).toBeUndefined()
  })
  it('projects a running operation before any screenshot exists and parses physical input coordinates', () => {
    const user: ChatMessage = { id: 'turn', kind: 'text', role: 'user', createdAt: 0, text: '操作电脑' }
    expect(toolPreviewState([user, { ...click, input: { loc: '[120, -80]' } }], 'computer')).toMatchObject({
      turnId: 'turn', hasTools: true, hasStarted: true, active: true,
      action: { title: '点击', status: '执行中', point: { x: 120, y: -80, space: 'screen' } },
    })
  })
  it('does not guess a transform for screenshot coordinates or expose typed content as a target', () => {
    expect(toolPreviewState([{ ...click, input: { loc: [120, 80], coordinate_space: 'screenshot' } }], 'computer').action?.point).toBeUndefined()
    expect(toolPreviewState([{ ...click, tool: 'mcp__trylo-windows__Type', input: { text: 'private-input' } }], 'computer').action?.target).toBe('')
  })
  it('keeps unfinished parallel operations as current instead of a completed neighbor', () => {
    const state = toolPreviewState([click, { ...screenshot, createdAt: 30 }], 'computer')
    expect(state.action?.id).toBe(click.id)
    expect(state.active).toBe(true)
  })
  it('marks unfinished invocations interrupted when the authoritative task ends', () => {
    expect(toolPreviewState([click], 'computer', { running: false })).toMatchObject({
      active: false, status: '已中断', action: { status: '已中断' },
    })
  })
  it('resets an old display selection at the new user turn boundary', () => {
    const old = { ...screenshot, input: { display: '[2]' } }
    const user: ChatMessage = { id: 'next', role: 'user', kind: 'text', createdAt: 30, text: '继续' }
    expect(toolPreviewState([old], 'computer').display).toBe(2)
    expect(toolPreviewState([old, user, click], 'computer').display).toBeUndefined()
  })
  it('keeps absolute step indices beyond the six visible history rows and uses real duration', () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ ...screenshot, id: `step-${i}`, createdAt: i * 10000,
      completedAt: i * 10000 + 210, durationMs: 210, tool: 'mcp__trylo-browser__browser_click', outputContent: undefined }))
    const state = toolPreviewState(steps, 'browser')
    expect(state.stepCount).toBe(9)
    expect(state.actions?.map(action => action.stepIndex)).toEqual([4, 5, 6, 7, 8, 9])
    expect(state.action).toMatchObject({ completedAt: 80210, durationMs: 210, stepIndex: 9 })
  })
  it('associates cached images only with the producing action, never the following click', () => {
    const shot = { ...screenshot, tool: 'mcp__trylo-browser__browser_take_screenshot', input: { filename: 'page.png' }, outputContent: undefined }
    const read = { ...screenshot, id: 'read', tool: 'Read', input: { file_path: '/task/page.png' } }
    const next = { ...click, tool: 'mcp__trylo-browser__browser_click' }
    const state = toolPreviewState([shot, read, next], 'browser')
    expect(state.actions?.[0]?.image).toBe(ref)
    expect(state.action?.image).toBeUndefined()
  })
  it('uses the matching current action error and output fallback rather than a parallel neighbor summary', () => {
    const failed = { ...click, status: 'error' as const, outputError: undefined, outputText: '点击超时' }
    expect(toolPreviewState([failed], 'computer').detail).toBe('点击超时')
    expect(toolPreviewState([{ ...failed, outputText: '' }], 'computer').detail).toBe('工具未返回失败原因。')
    expect(toolPreviewState([click, screenshot], 'computer').detail).toBe('')
  })
  it('settles after the task ends, with real final text or honest failure/interruption counts', () => {
    const browser = { ...click, tool: 'mcp__trylo-browser__browser_click', status: 'done' as const, input: { element: '保存' } }
    const text: ChatMessage = { id: 'final', kind: 'text', role: 'assistant', text: '已保存订单，可以继续付款。', createdAt: 100 }
    expect(toolPreviewState([browser, text], 'browser', { running: true }).settlement).toBeUndefined()
    expect(toolPreviewState([browser, text], 'browser', { running: false }).settlement?.summary).toBe(text.text)
    expect(toolPreviewState([{ ...browser, status: 'error' }], 'browser', { running: false }).settlement).toMatchObject({ outcome: 'failed', summary: expect.stringContaining('1 项失败') })
    expect(toolPreviewState([{ ...browser, status: 'running' }], 'browser', { running: false }).settlement).toMatchObject({ outcome: 'interrupted', summary: expect.stringContaining('1 项中断') })
  })
})
