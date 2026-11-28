import type { ChatMessage, ToolMessage } from '../components/chat/types'
import type { BinaryRef } from './tool-result-content'
import { toolEventStatus, toolEventVerb } from '../components/chat/tool-event-presentation'

export type PreviewKind = 'browser' | 'computer'
export interface ToolPreviewState {
  readonly title: string
  readonly status: string
  readonly detail: string
  readonly image?: BinaryRef
  readonly screenshotAt?: number
  readonly updatedAt?: number
  readonly actions?: readonly PreviewAction[]
  readonly url?: string
  readonly turnId?: string
  readonly hasTools?: boolean
  readonly hasStarted?: boolean
  readonly active?: boolean
  readonly action?: PreviewAction
  readonly display?: number
  readonly stepCount?: number
  readonly settlement?: { readonly outcome: 'done' | 'failed' | 'interrupted'; readonly summary: string }
}
export interface PreviewFrameGeometry {
  readonly width: number
  readonly height: number
  readonly originX?: number
  readonly originY?: number
  readonly cursorX?: number
  readonly cursorY?: number
}
export interface PreviewAction {
  readonly id: string
  readonly title: string
  readonly target: string
  readonly status: string
  readonly startedAt?: number
  readonly completedAt?: number
  readonly durationMs?: number
  readonly stepIndex?: number
  readonly error?: string
  readonly image?: BinaryRef
  readonly point?: { readonly x: number; readonly y: number; readonly space: 'screen' | 'normalized' | 'viewport'; readonly endX?: number; readonly endY?: number }
}
const ACTIONS: Readonly<Record<string, string>> = {
  browser_navigate: '打开网页', browser_click: '点击', browser_type: '输入', browser_fill_form: '填写表单',
  browser_snapshot: '查看页面', browser_take_screenshot: '截取页面', browser_tabs: '切换标签页',
  browser_evaluate: '检查页面', browser_wait_for: '等待页面', browser_press_key: '按键',
  browser_console_messages: '检查控制台', browser_network_requests: '检查网络', browser_hover: '悬停', browser_resize: '调整视口',
  click: '点击', type: '输入', snapshot: '观察屏幕', screenshot: '截取屏幕', scroll: '滚动',
  move: '移动指针', app: '切换应用', launch: '打开应用', drag: '拖动',
  navigate_page: '打开网页', new_page: '新建页面', click_element: '点击', take_screenshot: '截取页面',
  take_snapshot: '查看页面', select_page: '切换标签页', list_pages: '查看标签页',
  shortcut: '按键', wait: '等待', waitfor: '等待界面', clipboard: '使用剪贴板',
  displayinventory: '查看显示器', ocr: '识别屏幕文字', multiselect: '选择多个目标',
  fill: '填写表单', fill_form: '填写表单', press_key: '按键', hover: '悬停',
  status: '检查权限', list_apps: '查看应用', open_app: '打开应用', activate_app: '切换前台应用',
  list_windows: '查看窗口', inspect: '检查控件', ax_find: '查找后台控件', ax_read_text: '读取窗口文本',
  read_window_text: '识别窗口文字', ax_perform: '后台操作控件', ax_set_value: '后台写入控件',
  type_text: '输入文字', hotkey: '快捷键',
}
function actionTitle(tool: string): string {
  return ACTIONS[tool.split('__').at(-1)?.toLowerCase() ?? ''] ?? toolEventVerb(tool)
}
function actionTarget(message: ToolMessage): string {
  const input = message.input ?? {}
  const target = input.url ?? input.element ?? input.target ?? input.window ?? input.app_name ?? input.bundleId ?? input.action ?? input.selector ?? input.key
  return typeof target === 'string' ? target.slice(0, 180) : ''
}
function parseMacosNormalizedPoint(outputText?: string): PreviewAction['point'] {
  if (!outputText || !outputText.includes('normalizedPoint')) return undefined
  try {
    const parsed = JSON.parse(outputText) as { normalizedPoint?: { x?: unknown; y?: unknown } }
    const x = parsed?.normalizedPoint?.x
    const y = parsed?.normalizedPoint?.y
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      return { x, y, space: 'normalized' }
    }
  } catch {
    return undefined
  }
  return undefined
}
function actionPoint(message: ToolMessage): PreviewAction['point'] {
  if (/^mcp__trylo-macos__/i.test(message.tool)) {
    return parseMacosNormalizedPoint(message.outputText)
  }
  if (!/^mcp__trylo-windows__/i.test(message.tool)) return undefined
  let loc: unknown = message.input?.loc
  if (typeof loc === 'string') { try { loc = JSON.parse(loc) as unknown } catch { return undefined } }
  if (!Array.isArray(loc) || loc.length !== 2 || !loc.every(value => typeof value === 'number' && Number.isFinite(value))) return undefined
  // Screenshot coordinates require a receipt's transform; never draw them as screen pixels.
  if (message.input?.coordinate_space === 'screenshot') return undefined
  return { x: loc[0] as number, y: loc[1] as number, space: 'screen' }
}
function selectedDisplay(input: unknown): number | undefined {
  let displays = input
  if (typeof displays === 'string') { try { displays = JSON.parse(displays) as unknown } catch { return undefined } }
  const first = Array.isArray(displays) ? displays[0] as unknown : undefined
  return typeof first === 'number' && Number.isInteger(first) && first >= 0 ? first : undefined
}
export function previewKind(tool: string): PreviewKind | null {
  if (/^mcp__trylo-(windows|macos)__/i.test(tool)) return 'computer'
  if (/^mcp__trylo-(browser|playwright|chrome)__/i.test(tool)) return 'browser'
  return null
}

/** Only the active turn supplies a picture. A new task must never inherit an old frame. */
export function toolPreviewState(
  messages: readonly ChatMessage[],
  kind: PreviewKind,
  options: { readonly running?: boolean } = {},
): ToolPreviewState {
  let latest: ToolMessage | undefined
  let image: BinaryRef | undefined
  let screenshotAt: number | undefined
  let actions: PreviewAction[] = []
  let url: string | undefined
  let screenshotFile = ''
  let turnId: string | undefined
  let hasStarted = false
  let display: number | undefined
  let finalText = ''
  let screenshotOwner: string | undefined
  let manuallyStopped = false
  let stopSummary = ''
  for (const message of messages) {
    if (message.kind === 'text' && message.role === 'user' && !message.steerState) {
      latest = undefined
      image = undefined
      screenshotAt = undefined
      actions = []
      url = undefined
      screenshotFile = ''
      turnId = message.id
      hasStarted = false
      display = undefined
      finalText = ''
      screenshotOwner = undefined
      manuallyStopped = false
      stopSummary = ''
    }
    if (message.kind === 'notice' && message.id.startsWith('run-cancelled:') && (!message.turnId || message.turnId === turnId)) {
      manuallyStopped = true
      stopSummary = message.text
    }
    if (message.kind === 'text' && message.role === 'assistant' && latest) finalText = message.text.trim()
    if (message.kind !== 'tool') continue
    const ownsScreenshot = kind === 'browser' && message.tool.toLowerCase() === 'read' && screenshotFile !== '' &&
      typeof message.input?.file_path === 'string' && message.input.file_path.replaceAll('\\', '/').split('/').at(-1) === screenshotFile
    if (previewKind(message.tool) !== kind && !ownsScreenshot) continue
    if (typeof message.input?.filename === 'string' && /screenshot/i.test(message.tool)) {
      screenshotFile = message.input.filename.replaceAll('\\', '/').split('/').at(-1) ?? ''
      screenshotOwner = message.id
    }
    if (!ownsScreenshot) {
    latest = message
    hasStarted ||= message.status !== 'pending'
    display = selectedDisplay(message.input?.display) ?? display
    const status = options.running === false && (message.status === 'running' || message.status === 'pending') ? 'interrupted' : message.status
    const durationMs = message.durationMs ?? (message.completedAt === undefined ? undefined : message.completedAt - message.createdAt)
    actions.push({ id: message.id, title: actionTitle(message.tool), target: actionTarget(message), status: toolEventStatus(status),
      startedAt: message.createdAt, completedAt: message.completedAt,
      durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
      stepIndex: actions.length + 1, error: message.outputError || (status === 'error' ? message.outputText : undefined), point: actionPoint(message) })
    finalText = ''
    const pageUrl = message.outputText?.match(/Page URL:\s*(https?:\/\/[^\s]+)/)?.[1]
    if (pageUrl) url = pageUrl
    else if (typeof message.input?.url === 'string') url = message.input.url
    }
    for (const block of message.outputContent ?? []) {
      if (
        block.type === 'image' ||
        (block.type === 'resource' && block.ref?.mimeType.startsWith('image/'))
      ) {
        image = block.ref
        screenshotAt = message.createdAt
        const owner = ownsScreenshot ? screenshotOwner : message.id
        actions = actions.map(action => action.id === owner ? { ...action, image: block.ref } : action)
      }
    }
  }
  const active = actions.some(action => action.status === '执行中' || action.status === '待执行')
  const action = [...actions].reverse().find(item => item.status === '执行中' || item.status === '待执行') ?? actions.at(-1)
  const failed = actions.filter(item => item.status === '失败').length
  const interrupted = actions.filter(item => item.status === '已中断').length
  const done = actions.filter(item => item.status === '已完成').length
  const outcome = manuallyStopped ? 'interrupted' : failed ? 'failed' : interrupted ? 'interrupted' : 'done'
  const counts = [`已完成 ${done} 项操作`, ...(failed ? [`${failed} 项失败`] : []), ...(interrupted ? [`${interrupted} 项中断`] : [])].join('，')
  const lastTarget = action?.target ? ` · 最后：${action.title}『${action.target}』` : ''
  return {
    title: latest ? actionTitle(latest.tool) : kind === 'browser' ? '浏览器' : '电脑控制',
    status: action?.status ?? '等待工具操作',
    detail: action?.status === '失败' ? action.error || '工具未返回失败原因。'
      : action?.status === '已中断' ? action.error || '本轮已结束，操作尚未完成。'
      : action?.id === latest?.id ? latest?.summary ?? '' : '',
    image,
    screenshotAt,
    updatedAt: latest?.createdAt,
    actions: actions.slice(-6),
    url,
    turnId,
    hasTools: actions.length > 0,
    hasStarted,
    display,
    active,
    action,
    stepCount: actions.length,
    settlement: hasStarted && options.running === false && !active ? { outcome, summary: stopSummary || finalText || counts + lastTarget } : undefined,
  }
}
