// Trylo Desktop — Windows-MCP risk classifier.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.6 (分类与白名单) ×
// §6.3 (permission matrix) / §6.2 (audit rules) / §13 PR-6.
//
// The pinned surface under the manifest's `--tools` allowlist exposes
// exactly 14 tools: the 12 upstream-allowed ones, plus `Clipboard` (moved
// out of the excluded set for the 2026-09-04 CAD-workflow round) and `Ocr`
// (a fork-added screen-text reader). The server's own annotations are HINTS
// ONLY (§6.2): `Snapshot`/`Screenshot` claim read-only while drawing
// overlays and touching the screen — Trylo's own table decides, every call.
//
// Policy (§6.6 权限策略 mapped onto the pinned tool names):
//   Screenshot / Snapshot / DisplayInventory / Ocr
//       → screen-reading. FIRST read in a conversation requires the user's
//         explicit 屏幕读取同意 (a ScreenConsentLease); afterwards a
//         session-scoped lease auto-allows within that conversation (§6.6:
//         「第一次需要屏幕读取同意，之后可发会话级 lease」). read_only
//         WITHOUT consent → approval (the user may grant consent from the
//         card); the model cannot create or extend a lease.
//   Move / Scroll / Wait / WaitFor
//       → §6.6「已授权桌面任务内可自动」: automatic at every level ≥ ask
//         INSIDE an authorized desktop task (a live screen-consent lease in
//         this conversation); read_only denies them (they steer the desktop).
//   Click / MultiSelect
//       → 审批或 scoped lease (§6.6). A lease covers clicks for the TTL
//         after ONE user approval; without a lease every call is a prompt.
//         read_only → deny (§6.3 点击/输入拒绝).
//   Type / Shortcut / App / Clipboard
//       → 高影响，逐次审批 (§6.6). read_only → deny. NEVER auto —
//         typed text, system shortcuts and app launches are exactly the
//         surface §15.2 lists as bypass-immune; sensitive-value text
//         (password-like payloads) escalates the preview reason but the
//         decision is an approval either way. Clipboard joins this class
//         because mode='get' reads whatever the USER last copied (an
//         exfiltration-grade read) and mode='set' plants content the user
//         might paste somewhere sensitive.
//   敏感窗口 (§6.6): a target window title / label text carrying admin /
//         UAC / payment / credential semantics (任务管理器, UAC, 支付,
//         密码, 登录, 账号) → forced approval on EVERY level (the lease
//         never covers it), because Trylo cannot see what window is really
//         focused — the input names it.
//
// Path rules are NOT needed here: none of the 14 allowed tools takes a
// filesystem path (FileSystem/Process/Registry are in the excluded 7 and
// can never appear — the server argv allowlist removes them and the router
// denies any tool outside `expectedTools`).

import type { ApprovalPreview } from '../../approval/approval-preview'
import type { LoopEvent, ToolResultEvent, ToolUseEvent } from '../../host-adapter/loop-events'
import type {
  PackageRiskClassifier,
  SafeAudit,
  ToolRiskContext,
  ToolRiskDecision,
} from '../tool-risk-classifier'
import { inputDigestOf } from '../input-digest'

export const WINDOWS_SERVER_NAME = 'trylo-windows'

/** §6.6 session lease TTL. Same default as the browser origin lease
 *  (§6.5 短期授权 lease 默认 5 分钟) — a session-scoped authorization
 *  must not outlive a work session's attention span. */
export const WINDOWS_LEASE_TTL_MS = 5 * 60 * 1000

/** Alias used by tests and call sites that speak of consent rather than
 *  the generic lease — one TTL, one policy. */
export const SCREEN_CONSENT_TTL_MS = WINDOWS_LEASE_TTL_MS

/** Inputs above this canonical-JSON size are never auto-allowed (§14.2). */
const MAX_INPUT_JSON_LENGTH = 256 * 1024

// ── pinned tool surface (verified by the PR-6 tools/list smoke; the
// cross-package test pins this list against the manifest) ─────────────

export const WINDOWS_TOOL_NAMES = Object.freeze([
  'Screenshot',
  'Snapshot',
  'DisplayInventory',
  'Click',
  'Type',
  'Scroll',
  'Move',
  'Shortcut',
  'Wait',
  'WaitFor',
  'App',
  'MultiSelect',
  'Clipboard',
  'Ocr',
])

/** Full `mcp__trylo-windows__<tool>` names — the exact set both the
 *  manifest and the router must agree on (cross-package test pins it). */
export const WINDOWS_EXPECTED_TOOLS: readonly string[] = WINDOWS_TOOL_NAMES.map(
  (tool) => `mcp__${WINDOWS_SERVER_NAME}__${tool}`,
)

const SCREEN_READ_TOOLS = new Set<string>(['Screenshot', 'Snapshot', 'DisplayInventory', 'Ocr'])

const AMBIENT_CONTROL_TOOLS = new Set<string>(['Move', 'Scroll', 'Wait', 'WaitFor'])

const POINT_INTERACTION_TOOLS = new Set<string>(['Click', 'MultiSelect'])

const HIGH_IMPACT_TOOLS = new Set<string>(['Type', 'Shortcut', 'App', 'Clipboard'])

// ── sensitive-window semantics (§6.6 敏感窗口策略) ────────────────────

/** Free-text fields through which the model NAMES a window or element.
 *  Windows-MCP addresses targets by coordinates or UIA label/id numbers;
 *  the textual signals arrive via `text` (typed payload), `shortcut`,
 *  `name` (App), `condition`/`text`/`window_name` (WaitFor), the label
 *  descriptions, and the `window`/`element` free-text selectors
 *  (WCC-P2-01: A-15 — these were not checked before, so a model could aim
 *  a click at an elevated window through `window` while the summary read
 *  "当前指针位置"). */
const TARGET_TEXT_FIELDS = [
  'text',
  'shortcut',
  'name',
  'window_name',
  'condition',
  'window',
  'element',
] as const

/** §6.6: 密码框、管理员窗口、UAC、支付、发送、安装、账户/安全设置 —
 *  word-boundary matching over model-authored text; a false positive costs
 *  one extra approval, a false negative is a bypass. */
const SENSITIVE_TEXT_PATTERNS = [
  /\buac\b/i,
  /\badmin(istrator)?\b/i,
  /\b elevat(e|ed|ion)\b/i,
  /任务管理器/,
  /设备管理器/,
  /注册表/, // Registry semantics even though the Registry tool is excluded
  /\bpassword\b/i,
  /密码/,
  /口令/,
  /\bcredential/i,
  /\blogin\b/i,
  /\bsign[ -]?in\b/i,
  /登录/,
  /支付/,
  /\bpayment\b/i,
  /\bcheckout\b/i,
  /\bpurchase\b/i,
  /\bpay(ment)?\b/i,
  /\btransfer\b/i,
  /转账/,
  /汇款/,
  /\bdelete\b/i,
  /删除/,
  /卸载/,
  /\buninstall\b/i,
  /\bformat\b/i,
  /格式化/,
  /\binstall\b/i,
  /安装/,
  /账号/,
  /账户/,
  /安全设置/,
] as const

function sensitiveTextOf(input: Readonly<Record<string, unknown>>): boolean {
  for (const field of TARGET_TEXT_FIELDS) {
    const value = input[field]
    if (typeof value !== 'string') continue
    for (const pattern of SENSITIVE_TEXT_PATTERNS) {
      if (pattern.test(value)) return true
    }
  }
  return false
}

/** What the preview may echo. Typed `text` payloads are NEVER echoed
 *  (§6.2: no 键入文本 in previews) — the target description carries the
 *  coordinate/label shape only. WCC-P2-01: when the server resolved an
 *  exact target receipt, the summary shows THAT window (display title or
 *  HWND) instead of the model's free-text claims. */
function targetSummary(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const num = (value: unknown): string =>
    Array.isArray(value) ? value.map((v) => String(v)).join(',') : ''
  const receipt = targetReceiptOf(input)
  const windowLabel = receipt ? (receipt.title ?? `窗口 ${receipt.hwnd}`) : null
  switch (toolName) {
    case 'Click':
    case 'Move':
    case 'Scroll':
      if (windowLabel)
        return `${windowLabel} · ${input['label'] !== undefined && input['label'] !== null ? `UI 元素 #${String(input['label'])}` : num(input['loc']) || '目标位置'}`
      return input['label'] !== undefined && input['label'] !== null
        ? `UI 元素 #${String(input['label'])}`
        : num(input['loc']) || '当前指针位置'
    case 'MultiSelect':
      if (windowLabel)
        return `${windowLabel} · ${input['labels'] !== undefined && input['labels'] !== null ? `UI 元素 ${String(input['labels']).slice(0, 40)}` : `坐标 ${num(input['locs']).slice(0, 40)}`}`
      return input['labels'] !== undefined && input['labels'] !== null
        ? `UI 元素 ${String(input['labels']).slice(0, 40)}`
        : `坐标 ${num(input['locs']).slice(0, 40)}`
    case 'Type':
      if (windowLabel)
        return `${windowLabel} · ${input['label'] !== undefined && input['label'] !== null ? `UI 元素 #${String(input['label'])}` : num(input['loc']) || '焦点目标'}`
      return input['label'] !== undefined && input['label'] !== null
        ? `UI 元素 #${String(input['label'])}`
        : num(input['loc']) || '当前焦点'
    case 'Shortcut':
      return '（组合键已隐藏）'
    case 'App':
      return `应用操作 · ${String(input['mode'] ?? 'launch')}`
    case 'Clipboard':
      return input['mode'] === 'get' ? '剪贴板 · 读取当前内容' : '剪贴板 · 写入（内容已隐藏）'
    case 'Ocr':
      return input['region'] !== undefined && input['region'] !== null
        ? `屏幕区域 OCR ${String(input['region']).slice(0, 40)}`
        : '整屏 OCR'
    case 'Wait':
      return `等待 ${String(input['duration'] ?? '?')} 秒`
    case 'WaitFor':
      return windowLabel
        ? `${windowLabel} · 等待条件 · ${String(input['condition'] ?? '?')}`
        : `等待条件 · ${String(input['condition'] ?? '?')}`
    case 'Snapshot':
      return input['region'] !== undefined && input['region'] !== null
        ? `屏幕区域 ${String(input['region']).slice(0, 40)}`
        : '整个桌面'
    case 'Screenshot':
      return '屏幕截图'
    case 'DisplayInventory':
      return '显示器清单'
    default:
      return toolName
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inputJsonLength(input: Readonly<Record<string, unknown>>): number {
  try {
    return JSON.stringify(input).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

// ── desktop leases (§6.6 会话级 lease) ───────────────────────────────

export interface WindowsLeaseGrant {
  /** Discriminates the grant kind inside the shared registry plumbing AND
   *  scopes the store: a SCREEN-READ consent (§6.6 屏幕读取同意 — unlocks
   *  ambient steering) is a different human decision from a CLICK lease
   *  (§6.6「审批或 scoped lease」— unlocks clicks only). One approval must
   *  never silently mint the other kind of authorization. */
  readonly kind: 'windows-screen' | 'windows-click'
  readonly actionClass: 'windows-desktop'
  readonly conversationId: string
  readonly ttlMs: number
  /** WCC-P2-01: the host-resolved window the approval was shown FOR. The
   *  server (MCP tool) resolves `window`/`window_name` to an exact HWND +
   *  owner PID; the classifier receives that receipt via the input's
   *  `_target` envelope and echoes it here so the lease covers ONE window,
   *  not every window the conversation might touch. Absent for tools that
   *  address no specific window (screen reads, App, Shortcut, …) — those
   *  keep the conversation-scoped semantics. */
  readonly window?: TargetReceipt
}

// ── target receipts (WCC-P2-01: host-visible exact target identity) ──

/**
 * What the server RESOLVED a request's `window`/`window_name`/`element` to,
 * passed back to the host inside the tool input under the reserved `_target`
 * key. This is the host's only trustworthy description of the target: every
 * other field is model-authored text. The digest — not the title — is what
 * a lease is bound to and what approvals summarize.
 *
 * `title` is display-only. It is NEVER matched against the sensitive-text
 * patterns' authorization path (it may be shown on the card) and never used
 * to route a lease: two windows with the same title share a title but never
 * a receipt digest.
 */
export interface TargetReceipt {
  readonly hwnd: number
  readonly pid: number
  /** Process creation time in 100ns units, when the server could read it.
   *  Two processes can share a PID across a restart; this is what tells
   *  them apart (spec §7.1 ProcessInstanceRef). */
  readonly processStartedAt100ns?: number
  /** Server-side digest of the full window identity (HWND + PID + start
   *  time + desktop session). Lease scope keys on this, not the title. */
  readonly digest: string
  /** Display-only window title (truncated by the server). */
  readonly title?: string
}

/** The reserved input key carrying the server-resolved target. Kept flat
 *  (`_target.window`) so a future element receipt can be added without a
 *  contract break. */
export const TARGET_RECEIPT_INPUT_KEY = '_target'

/** The model-facing tool parameter carrying the same receipt (WCC-P2-02):
 *  the model copies a Window Receipt verbatim from a Snapshot. The server
 *  re-verifies it at dispatch, so a forged or stale receipt fails closed
 *  there; on the host it only ever NARROWS the approval scope. */
export const WINDOW_RECEIPT_PARAM_KEY = 'window_receipt'

function receiptFromObject(value: unknown): TargetReceipt | null {
  if (!isPlainRecord(value)) return null
  const hwnd = value['hwnd']
  const pid = value['pid']
  const digest = value['digest']
  if (typeof hwnd !== 'number' || !Number.isInteger(hwnd) || hwnd <= 0) return null
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof digest !== 'string' || digest.length === 0 || digest.length > 128) return null
  const processStartedAt100ns = value['processStartedAt100ns']
  const title = value['title']
  return {
    hwnd,
    pid,
    digest,
    ...(typeof processStartedAt100ns === 'number' && Number.isFinite(processStartedAt100ns)
      ? { processStartedAt100ns }
      : {}),
    ...(typeof title === 'string' && title.length > 0 ? { title: title.slice(0, 200) } : {}),
  }
}

/**
 * Read the exact-target receipt from a tool input. Two carriers:
 *  - the reserved `_target` envelope (host/server middleware, `_target.window`);
 *  - the model-facing `window_receipt` parameter (copied verbatim from a
 *    Snapshot's Window Receipts).
 * Returns null for anything malformed — callers must treat "no valid receipt"
 * as "the request names no exact target", not as an error: legacy inputs
 * legitimately carry none, and fail-closed for those means
 * conversation-scoped approval, never a guessed window scope.
 */
export function targetReceiptOf(input: Readonly<Record<string, unknown>>): TargetReceipt | null {
  const envelope = input[TARGET_RECEIPT_INPUT_KEY]
  if (isPlainRecord(envelope)) {
    const receipt = receiptFromObject(envelope['window'])
    if (receipt !== null) return receipt
  }
  return receiptFromObject(input[WINDOW_RECEIPT_PARAM_KEY])
}

const LEASE_LIMIT = 256

/**
 * In-memory lease store. Deliberately part of the classifier instance:
 * classification stays synchronous (no I/O, no clock — `at` is injected),
 * and the state only ever EXPANDS auto-allow for a conversation where a
 * human already granted consent. The model has no path that creates a
 * lease; only a user approval through the permission registry does.
 *
 * Unlike the browser origin lease this is NOT origin-scoped: §6.6 grants a
 * conversation-level consent for reading/steering the USER'S OWN desktop,
 * which is one origin by construction. It dies with the app (memory only),
 * and every sensitive-window hit overrides it.
 *
 * Entries are keyed by `kind::conversationId` so the two documented lease
 * kinds cannot stand in for each other (audit 2026-09-02: the click lease
 * was granted as a screen consent AND never consulted — approving one click
 * silently unlocked steering while the promised click auto-allow never
 * happened; both halves are fixed here).
 */
export class ScreenConsentLeases {
  private readonly entries = new Map<string, number>()

  /** Record a user-granted lease. A re-approval resets the TTL — that is
   *  a fresh human decision, not the model expanding a lease. A window-
   *  scoped grant (WCC-P2-01) is keyed by the receipt digest, so it can
   *  never authorize a different window in the same conversation. */
  grant(grant: WindowsLeaseGrant, at: number = Date.now()): void {
    this.prune(at)
    this.entries.set(
      leaseKey(grant.kind, grant.conversationId, grant.window?.digest),
      at + Math.max(0, grant.ttlMs),
    )
    if (this.entries.size > LEASE_LIMIT) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  /** True when a live SCREEN-CONSENT lease covers this conversation (the
   *  gate for screen reads and ambient steering). */
  active(conversationId: string, at: number): boolean {
    return this.activeScope('windows-screen', conversationId, at)
  }

  /** True when a live lease of ONE kind covers this conversation AND the
   *  requested window. WCC-P2-01 scoping rules:
   *  - a request WITHOUT a resolved target is covered only by a
   *    conversation-scoped lease (the legacy grant shape);
   *  - a request FOR a window is covered by that window's own lease, or
   *    falls back to the conversation-scoped lease only when the user
   *    granted one without a window receipt;
   *  - a lease minted for window A NEVER covers window B — a different
   *    digest is a different human decision. */
  activeScope(
    kind: WindowsLeaseGrant['kind'],
    conversationId: string,
    at: number,
    windowDigest?: string,
  ): boolean {
    if (windowDigest) {
      const scoped = this.entries.get(leaseKey(kind, conversationId, windowDigest))
      if (scoped !== undefined) {
        if (scoped > at) return true
        this.entries.delete(leaseKey(kind, conversationId, windowDigest))
      }
      // Fall through to the conversation-scoped entry: an approval made
      // before the host could resolve an exact target still means "this
      // conversation", and the user saw a non-window-scoped card for it.
    }
    const key = leaseKey(kind, conversationId)
    const expiresAt = this.entries.get(key)
    if (expiresAt === undefined) return false
    if (expiresAt <= at) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  /** Drop ONE conversation's leases (every kind, every window scope) — the
   *  per-conversation emergency-stop path (§13 PR-6: stop 后无残留控制). */
  revokeConversation(conversationId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.endsWith(`::${conversationId}`) || key.includes(`::${conversationId}::`)) {
        this.entries.delete(key)
      }
    }
  }

  /** Drop ALL leases immediately — the global emergency-stop path. */
  revokeAll(): void {
    this.entries.clear()
  }

  /** Drop window-SCOPED leases when the user's attention moved away from the
   *  granted window (WCC-P2-01: `revokeOn: foreground_changed`). The server
   *  reports which window became foreground (HWND); a scope whose digest no
   *  longer matches the foreground window dies because the human decision
   *  was "you may act in THAT window" — unattended leases outliving the
   *  context the user saw are exactly the residual-control hazard §13 names.
   *
   *  Conversation-scoped (legacy) leases are deliberately NOT touched: they
   *  were granted without a window context, and the UAC watcher plus the
   *  sensitive-text path remain their safety net. */
  revokeScopeFor(foregroundDigest: string | null): void {
    if (!foregroundDigest) return
    for (const key of [...this.entries.keys()]) {
      // Window-scoped keys look like `<kind>::<conversation>::<digest>`.
      const digest = key.split('::')[2]
      if (digest !== undefined && digest !== foregroundDigest) {
        this.entries.delete(key)
      }
    }
  }

  private prune(at: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= at) this.entries.delete(key)
    }
  }
}

function leaseKey(
  kind: WindowsLeaseGrant['kind'],
  conversationId: string,
  windowDigest?: string,
): string {
  return windowDigest ? `${kind}::${conversationId}::${windowDigest}` : `${kind}::${conversationId}`
}

// ── §11.3 用户接管 (WCC-P2-04): takeover escalation ──────────────────────

/** How long a user takeover escalates the conversation. The user grabbing
 *  the mouse/keyboard is THE clearest possible "I need control" signal —
 *  after it, every desktop call is a forced approval for this window. The
 *  TTL matches the lease default (§6.6): one human attention span. */
export const TAKEOVER_ESCALATION_TTL_MS = 5 * 60 * 1000

const ESCALATION_LIMIT = 64

/**
 * Bounded store of per-conversation takeover escalations, derived ONLY from
 * server-reported takeover facts (`takeover` in the trylo-target block) —
 * the model cannot create or extend one, and a lease never covers it.
 *
 * While an escalation is live for a conversation, EVERY windows-tool call
 * is a forced per-call approval (sensitive), regardless of any lease —
 * the same bypass-immune treatment sensitive text gets (§6.6 敏感窗口),
 * because the user just grabbed the desktop out of the agent's hands.
 */
export class TakeoverEscalations {
  private readonly entries = new Map<string, number>()

  record(conversationId: string, at: number = Date.now()): void {
    this.prune(at)
    this.entries.set(conversationId, at + TAKEOVER_ESCALATION_TTL_MS)
    if (this.entries.size > ESCALATION_LIMIT) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  active(conversationId: string, at: number): boolean {
    const expiresAt = this.entries.get(conversationId)
    if (expiresAt === undefined) return false
    if (expiresAt <= at) {
      this.entries.delete(conversationId)
      return false
    }
    return true
  }

  revokeConversation(conversationId: string): void {
    this.entries.delete(conversationId)
  }

  revokeAll(): void {
    this.entries.clear()
  }

  private prune(at: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= at) this.entries.delete(key)
    }
  }
}

/**
 * Feed a finished windows tool result into the escalation store: a result
 * whose trylo-target facts carry `takeover` records the conversation. The
 * watcher wiring calls this in the same onEvents pass as the lease
 * revocation path. Returns true when an escalation fired (caller may log).
 */
export function escalateOnTakeover(
  escalations: TakeoverEscalations,
  events: readonly LoopEvent[],
  conversationId: string,
): boolean {
  let fired = false
  for (const event of events) {
    if (event.type !== 'tool_result') continue
    const result = event as ToolResultEvent
    if (!result.tool.startsWith(`mcp__${WINDOWS_SERVER_NAME}__`)) continue
    const facts = targetResultFactsOf(
      result.content ?? (result.output ? [{ type: 'text', text: result.output }] : undefined),
    )
    if (facts?.takeover) {
      escalations.record(conversationId)
      fired = true
    }
  }
  return fired
}

// ── output-side sensitive-window recognition (§6.6 偏差③收口) ─────────

/**
 * Markers that a UAC / elevated / secure-desktop surface is ON SCREEN,
 * matched against the TEXT the server echoed back (Snapshot a11y tree,
 * window titles in results). Deliberately tighter than the input-side
 * list: revocation is a heavier hammer than one extra approval, so only
 * elevation/UAC semantics fire it — credential/payment wording on the
 * input side is already covered by `sensitive_target`.
 *
 * Honest boundary: a TRUE UAC prompt runs on the secure desktop, which a
 * normal-process UIA snapshot cannot see (Windows security design). This
 * recognition therefore catches elevated window titles and UAC artefacts
 * that ARE visible; the invisible-secure-desktop case remains covered by
 * the input-side forced-approval list.
 */
const SENSITIVE_WINDOW_OUTPUT_PATTERNS = [
  /用户账户控制/,
  /\bUser Account Control\b/i,
  /以管理员身份/,
  /管理员[:：]/,
  /\bAdministrator[:：]/,
  /\bconsent\.exe\b/i,
  /安全桌面/,
] as const

/** True when a screen-read result text shows a UAC / elevated window. */
export function outputIndicatesSensitiveWindow(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text === '') return false
  return SENSITIVE_WINDOW_OUTPUT_PATTERNS.some((pattern) => pattern.test(text))
}

/** Bounded in-flight tracker: toolCallIds of THIS conversation's
 *  `mcp__trylo-windows__*` calls, so a result arriving in a LATER event
 *  batch can still be attributed to the server that produced it. */
const WATCHER_PENDING_LIMIT = 64

export interface SensitiveWindowWatcher {
  /** Ingest one event batch. Returns true when a result text triggered a
   *  consent revocation this batch (the caller may log; never required). */
  (events: readonly LoopEvent[], conversationId: string): boolean
}

/**
 * WCC-P2-01 `revokeOn: foreground_changed`: a server-resolved foreground
 * digest arrives on a windows tool result (`_target.foregroundDigest`); the
 * window-scoped leases whose digest no longer matches are withdrawn BEFORE
 * the batch is projected. Conversation-scoped leases are untouched (see
 * `revokeScopeFor`). Returns true when any revocation fired.
 */
export function revokeOnForegroundChange(
  leases: ScreenConsentLeases,
  events: readonly LoopEvent[],
  _conversationId: string,
): boolean {
  let revoked = false
  for (const event of events) {
    if (event.type !== 'tool_result') continue
    const result = event as ToolResultEvent
    if (!result.tool.startsWith(`mcp__${WINDOWS_SERVER_NAME}__`)) continue
    const digest = resultTargetDigest(result)
    if (digest !== null) {
      leases.revokeScopeFor(digest)
      revoked = true
    }
  }
  return revoked
}

/** Read the server-reported foreground digest from a tool result's
 *  structured content. The server appends a small text block of the form
 *  `trylo-target:{"foregroundDigest":"…"}` — primitive JSON only, so no
 *  structured-content parsing beyond `JSON.parse` on a known prefix. */
function resultTargetDigest(result: ToolResultEvent): string | null {
  const blocks = result.content ?? []
  for (const block of blocks) {
    if (block.type !== 'text') continue
    const text = block.text
    if (typeof text !== 'string') continue
    const marker = text.indexOf(TARGET_RESULT_PREFIX)
    if (marker < 0) continue
    try {
      const parsed: unknown = JSON.parse(text.slice(marker + TARGET_RESULT_PREFIX.length))
      if (parsed && typeof parsed === 'object') {
        const digest = (parsed as Record<string, unknown>)['foregroundDigest']
        if (typeof digest === 'string' && digest.length > 0 && digest.length <= 128) {
          return digest
        }
        return null
      }
    } catch {
      return null
    }
  }
  return null
}

/** Marker prefix the server uses on result blocks carrying target facts. */
export const TARGET_RESULT_PREFIX = 'trylo-target:'

/** Facts the server appends to a mutation tool result (WCC-P2-01). */
export interface TargetResultFacts {
  readonly window: TargetReceipt
  readonly foregroundDigest: string | null
  /** dispatch/effect verbatim from the ActionResult enum values. */
  readonly dispatch?: string
  readonly effect?: string
  readonly channel?: string
  /** WCC-P2-04 (spec §11.3): user takeover during the dispatch window —
   *  `safe_release` | `yielded` | `cancelled` | `verifying`. Identity only;
   *  the classifier escalates the conversation to forced per-call approvals
   *  and the UI shows the state. */
  readonly takeover?: string
}

/** Parse the ``trylo-target:{…}`` fact block out of tool-result content
 *  blocks. The server may deliver the facts as their own text block OR
 *  appended after the legacy text, so the prefix is located with indexOf.
 *  Returns null when absent or malformed — the UI then renders no target
 *  row at all instead of guessing. */
export function targetResultFactsOf(
  content: readonly { readonly type: string; readonly text?: string }[] | undefined,
): TargetResultFacts | null {
  if (!content) return null
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const marker = block.text.indexOf(TARGET_RESULT_PREFIX)
    if (marker < 0) continue
    try {
      const parsed: unknown = JSON.parse(block.text.slice(marker + TARGET_RESULT_PREFIX.length))
      if (!parsed || typeof parsed !== 'object') return null
      const record = parsed as Record<string, unknown>
      // The facts JSON carries `window` at the top level; targetReceiptOf
      // validates the `_target.window` envelope, so wrap before validating.
      const receipt = targetReceiptOf({ [TARGET_RECEIPT_INPUT_KEY]: record })
      if (receipt === null) return null
      const foregroundDigest = record['foregroundDigest']
      const asString = (value: unknown): string | undefined =>
        typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined
      return {
        window: receipt,
        foregroundDigest:
          typeof foregroundDigest === 'string' &&
          foregroundDigest.length > 0 &&
          foregroundDigest.length <= 128
            ? foregroundDigest
            : null,
        ...(asString(record['dispatch']) ? { dispatch: asString(record['dispatch']) } : {}),
        ...(asString(record['effect']) ? { effect: asString(record['effect']) } : {}),
        ...(asString(record['channel']) ? { channel: asString(record['channel']) } : {}),
        ...(asString(record['takeover']) ? { takeover: asString(record['takeover']) } : {}),
      }
    } catch {
      return null
    }
  }
  return null
}

/**
 * PR-6 偏差③收口 + WCC-P2-01 前台撤销 (§6.6 「拒绝自动化」分支; lease
 * `revokeOn: foreground_changed`): watch the OUTPUT side of the desktop
 * surface. When a windows tool result reveals a UAC / elevated /
 * secure-desktop window, the conversation's screen-consent lease is
 * WITHDRAWN — every subsequent desktop action (steering, clicks, even
 * screen reads) falls back to explicit human approval until the user
 * re-grants consent. The model cannot re-grant it: only an approval through
 * the permission registry does (same invariant as every lease).
 */
export function createSensitiveWindowWatcher(leases: ScreenConsentLeases): SensitiveWindowWatcher {
  const pending = new Map<string, true>()
  return (events, conversationId) => {
    let revoked = false
    for (const event of events) {
      if (event.type === 'tool_use') {
        const use = event as ToolUseEvent
        if (use.tool.startsWith(`mcp__${WINDOWS_SERVER_NAME}__`)) {
          pending.set(use.id, true)
          if (pending.size > WATCHER_PENDING_LIMIT) {
            const oldest = pending.keys().next().value
            if (oldest !== undefined) pending.delete(oldest)
          }
        }
        continue
      }
      if (event.type !== 'tool_result') continue
      const result = event as ToolResultEvent
      if (!pending.delete(result.id)) continue
      const textBlocks = (result.content ?? [])
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
      const text = [result.output ?? '', ...textBlocks].join('\n')
      if (outputIndicatesSensitiveWindow(text)) {
        leases.revokeConversation(conversationId)
        revoked = true
      }
    }
    return revoked
  }
}

// ── decision plumbing ────────────────────────────────────────────────

const DENY_MESSAGES: Readonly<Record<string, string>> = {
  malformed_input:
    'Denied: the desktop tool input could not be parsed safely. Send the tool its documented string/number fields.',
  unknown_tool: 'Denied: this tool is not part of the pinned Windows desktop tool set.',
  interaction_denied_read_only:
    'Denied: this conversation is read-only. Desktop clicks, selection and typing are unavailable.',
  high_impact_denied_read_only:
    'Denied: this conversation is read-only. Typing, keyboard shortcuts and app launches are unavailable.',
  desktop_denied_read_only:
    'Denied: this conversation is read-only. Desktop mouse steering is unavailable.',
  screen_denied_read_only:
    'Denied: this conversation is read-only. Reading the screen is unavailable.',
  oversized: 'Denied: the desktop tool input exceeds the automatic classification bound.',
}

function denyMessage(reasonCode: string): string {
  return DENY_MESSAGES[reasonCode] ?? `Denied: ${reasonCode}.`
}

interface WindowsAnalysis {
  readonly problem: string | null
  readonly oversized: boolean
  readonly hasSensitiveText: boolean
}

function analyzeWindowsInput(input: Readonly<Record<string, unknown>>): WindowsAnalysis {
  const base: WindowsAnalysis = {
    problem: null,
    oversized: inputJsonLength(input) > MAX_INPUT_JSON_LENGTH,
    hasSensitiveText: false,
  }
  if (!isPlainRecord(input)) return { ...base, problem: 'malformed_input' }
  return { ...base, hasSensitiveText: sensitiveTextOf(input) }
}

function buildAudit(
  context: ToolRiskContext,
  behavior: SafeAudit['behavior'],
  risk: SafeAudit['risk'],
  reasonCode: string,
): SafeAudit {
  return {
    at: context.at,
    profileId: context.profileId,
    packageId: context.packageId,
    toolName: context.toolName,
    behavior,
    risk,
    reasonCode,
    inputDigest: inputDigestOf(context.input),
    // No path fields exist on this surface; nothing to zone.
    pathZones: [],
  }
}

// ── the §6.6 × §6.3 matrix ───────────────────────────────────────────

export function classifyWindowsTool(
  context: ToolRiskContext,
  options: {
    readonly screenConsent?: ScreenConsentLeases | null
    readonly takeoverEscalations?: TakeoverEscalations | null
  } = {},
): ToolRiskDecision {
  const shortName = context.toolName.split('__').pop() ?? context.toolName
  const analysis = analyzeWindowsInput(context.input)

  const deny = (reasonCode: string): ToolRiskDecision => ({
    behavior: 'deny',
    reasonCode,
    userMessage: denyMessage(reasonCode),
    audit: buildAudit(context, 'deny', null, reasonCode),
  })
  const prompt = (
    risk: 'external' | 'sensitive' | 'destructive',
    reasonCode: string,
    reasonText: string,
    lease?: WindowsLeaseGrant,
  ): ToolRiskDecision => ({
    behavior: 'prompt',
    risk,
    reasonCode,
    preview: buildWindowsApprovalPreview(context, reasonText),
    ...(lease ? { lease } : {}),
    audit: buildAudit(context, 'prompt', risk, reasonCode),
  })
  const autoAllow = (
    reasonCode: string,
    risk: 'read' | 'workspace-write' = 'read',
  ): ToolRiskDecision => ({
    behavior: 'auto_allow',
    risk,
    reasonCode,
    audit: buildAudit(context, 'auto_allow', risk, reasonCode),
  })

  if (analysis.problem) return deny(analysis.problem)
  // A 完全自动：oversized / 敏感语义在 unrestricted 下也不卡（仅审计），其余硬拒绝仍拦
  if (context.permissionLevel === 'unrestricted') {
    return autoAllow('unrestricted')
  }
  // §11.3 用户接管 (WCC-2-04): the user seized the desktop during a recent
  // action. EVERY windows call in this conversation is a forced per-call
  // approval until the escalation TTL expires — leases, consent, and
  // screen reads alike (bypass-immune, like the sensitive-text path).
  if (options.takeoverEscalations?.active(context.conversationId, context.at)) {
    if (context.permissionLevel === 'read_only') return deny('screen_denied_read_only')
    return prompt(
      'sensitive',
      'takeover_requires_approval',
      '检测到用户接管：桌面控制已交还给您，后续每个操作需逐次审批',
    )
  }
  if (analysis.oversized) {
    // §6.2/§14.2: 非完全自动下 oversized 仍需人工
    return prompt('sensitive', 'input_too_large', '输入超过自动分类上限，需人工确认')
  }

  // 敏感语义：非完全自动下强制审批（unrestricted 已在上方放行）
  if (analysis.hasSensitiveText) {
    return prompt(
      'sensitive',
      'sensitive_target',
      '目标包含密码/支付/管理员/破坏性等敏感语义，强制审批',
    )
  }

  // ── screen reading (Screenshot / Snapshot / DisplayInventory) ──
  if (SCREEN_READ_TOOLS.has(shortName)) {
    if (context.permissionLevel === 'read_only') return deny('screen_denied_read_only')
    if (options.screenConsent?.active(context.conversationId, context.at)) {
      return autoAllow('screen_consent_leased')
    }
    // FIRST screen read in this conversation: the user grants consent by
    // approving; the approval itself issues the session lease.
    return prompt(
      'sensitive',
      'screen_consent_required',
      '读取屏幕需要您的同意（批准后本会话内生效）',
      {
        kind: 'windows-screen',
        actionClass: 'windows-desktop',
        conversationId: context.conversationId,
        ttlMs: WINDOWS_LEASE_TTL_MS,
      },
    )
  }

  // ── ambient steering (Move / Scroll / Wait / WaitFor) ──
  if (AMBIENT_CONTROL_TOOLS.has(shortName)) {
    if (context.permissionLevel === 'read_only') return deny('desktop_denied_read_only')
    // §6.6「已授权桌面任务内可自动」: inside a consented desktop task these
    // cannot exfiltrate anything by themselves.
    if (options.screenConsent?.active(context.conversationId, context.at)) {
      return autoAllow('desktop_task_leased')
    }
    return prompt(
      'external',
      'desktop_task_requires_consent',
      '未获得桌面操作授权：先批准一次屏幕读取以开启桌面任务',
    )
  }

  // ── point interaction (Click / MultiSelect) ──
  if (POINT_INTERACTION_TOOLS.has(shortName)) {
    if (context.permissionLevel === 'read_only') return deny('interaction_denied_read_only')
    // §6.6「审批或 scoped lease」: one approval grants a CLICK lease that
    // covers subsequent clicks in this conversation for the TTL. The click
    // lease is a DIFFERENT kind from the screen consent — it never unlocks
    // steering or screen reads (audit 2026-09-02: the lease used to be
    // granted but never consulted, so the promised auto-allow never
    // happened while every approval silently minted a screen consent).
    // WCC-P2-01: when the server resolved an exact target window, the
    // lease is bound to THAT window's receipt digest — an A-window
    // approval can never auto-allow a B-window click.
    const receipt = targetReceiptOf(context.input)
    const windowDigest = receipt?.digest
    if (
      options.screenConsent?.activeScope(
        'windows-click',
        context.conversationId,
        context.at,
        windowDigest,
      )
    ) {
      return autoAllow(windowDigest ? 'click_leased_window' : 'click_leased')
    }
    return prompt(
      'external',
      'click_requires_approval',
      windowDigest
        ? '桌面点击需审批（批准后 5 分钟内仅此窗口的点击自动放行）'
        : '桌面点击需审批（批准后 5 分钟内本会话点击自动放行）',
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: context.conversationId,
        ttlMs: WINDOWS_LEASE_TTL_MS,
        ...(receipt ? { window: receipt } : {}),
      },
    )
  }

  // ── high impact (Type / Shortcut / App / Clipboard) ──
  if (HIGH_IMPACT_TOOLS.has(shortName)) {
    if (context.permissionLevel === 'read_only') return deny('high_impact_denied_read_only')
    // §6.6「Type/Shortcut/App：高影响，逐次审批」— never auto, never
    // lease-covered. Type carries arbitrary text; Shortcut reaches system
    // dialogs; App launches executables; Clipboard reads whatever the user
    // last copied and plants content they may paste elsewhere.
    return prompt(
      'sensitive',
      'high_impact_requires_approval',
      '键入/快捷键/启动应用/剪贴板为高影响操作，逐次审批',
    )
  }

  // A tool the manifest pins but this classifier does not know: fail closed.
  return deny('unknown_tool')
}

// ── safe preview ─────────────────────────────────────────────────────

/**
 * Safe, redacted ApprovalPreview for a desktop request. Shows the tool
 * class and the target SHAPE (element label or coordinates). It never
 * echoes typed text, shortcut combos, or app/executable names (§6.2: no
 * 键入文本; a shortcut combo or exe name is a payload, not a summary).
 */
export function buildWindowsApprovalPreview(
  context: Pick<ToolRiskContext, 'toolName' | 'input'>,
  reasonText?: string,
): ApprovalPreview {
  try {
    const shortName = context.toolName.split('__').pop() ?? context.toolName
    const input = isPlainRecord(context.input) ? context.input : {}
    // The visual preview block: action class + target shape. Per acceptance
    // C06 the TYPED TEXT itself is NEVER echoed — only its length (the same
    // redaction rule Shortcut/Combo already follow in targetSummary).
    // Clipboard set-mode text is equally hidden: its length only.
    const textChars =
      (shortName === 'Type' || (shortName === 'Clipboard' && input['mode'] === 'set')) &&
      typeof input['text'] === 'string'
        ? (input['text'] as string).length
        : undefined
    return {
      kind: 'desktop',
      title: '桌面操作',
      actionLabel: actionLabelFor(shortName),
      target: targetSummary(shortName, input),
      ...(textChars !== undefined ? { textChars } : {}),
      reason: reasonText ?? defaultRiskText(shortName),
    }
  } catch {
    return {
      kind: 'desktop',
      title: '桌面操作',
      actionLabel: 'Windows 桌面工具调用',
      target: 'windows',
      reason: '未能解析此请求的参数',
    }
  }
}

/** The action class shown on the approval card's visual block. */
function actionLabelFor(shortName: string): string {
  if (SCREEN_READ_TOOLS.has(shortName)) return '屏幕读取'
  if (shortName === 'Type') return '键入（内容已隐藏）'
  if (shortName === 'Shortcut') return '组合键（已隐藏）'
  if (shortName === 'App') return '应用操作（名称已隐藏）'
  if (shortName === 'Clipboard') return '剪贴板（内容已隐藏）'
  if (POINT_INTERACTION_TOOLS.has(shortName)) return '桌面点击 / 选择'
  if (AMBIENT_CONTROL_TOOLS.has(shortName)) return '指针 / 等待'
  return 'Windows 桌面工具调用'
}

function defaultRiskText(shortName: string): string {
  if (SCREEN_READ_TOOLS.has(shortName)) return '屏幕读取'
  if (HIGH_IMPACT_TOOLS.has(shortName)) return '高影响桌面操作'
  if (POINT_INTERACTION_TOOLS.has(shortName)) return '桌面点击/选择'
  if (AMBIENT_CONTROL_TOOLS.has(shortName)) return '桌面指针/等待'
  return 'Windows 桌面工具调用'
}

/** The classifier registered by the router (manifest twin: classifierId
 *  `windows-mcp`, server `trylo-windows`, the 14 pinned tools). */
export const windowsClassifier: PackageRiskClassifier = {
  id: 'windows-mcp',
  serverName: WINDOWS_SERVER_NAME,
  expectedTools: WINDOWS_EXPECTED_TOOLS,
  classify: (context) => classifyWindowsTool(context),
}

export default windowsClassifier

/**
 * Production constructor: App wires the SAME consent store into the
 * classifier and the permission registry's `onLeaseGrant`, so a user
 * approval of one screen read unlocks the conversation's desktop task
 * until the TTL expires (§6.6). `takeoverEscalations` is the §11.3 store:
 * fed by the onEvents watcher (server-reported takeover facts), consulted
 * by the classifier to force per-call approvals after a user takeover.
 */
export function createWindowsClassifier(
  options: {
    readonly screenConsent?: ScreenConsentLeases | null
    readonly takeoverEscalations?: TakeoverEscalations | null
  } = {},
): PackageRiskClassifier {
  return {
    id: 'windows-mcp',
    serverName: WINDOWS_SERVER_NAME,
    expectedTools: WINDOWS_EXPECTED_TOOLS,
    classify: (context) => classifyWindowsTool(context, options),
  }
}
