// Trylo Desktop — Windows-MCP risk classifier tests.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.6 (权限策略) ×
// §6.3 (permission matrix) / §6.2 (audit rules) / §13 PR-6.
//
// PR-6 acceptance pinned here:
//   - read_only: NO click/type/selection/steering (all deny);
//   - screen reads need explicit consent once, then a session lease;
//   - Click/MultiSelect are approval-or-lease, never auto;
//   - Type/Shortcut/App/Clipboard are per-call approvals at
//     ask/workspace_write (never leased; unrestricted auto-allows);
//   - sensitive window/semantics text forces approval at every level,
//     lease or not (bypass-immune);
//   - the 7 excluded tools can never route here (router denies them before
//     the classifier runs — pinned in tool-risk-classifier.test.ts).

import { describe, expect, it } from 'vitest'

import {
  SCREEN_CONSENT_TTL_MS,
  ScreenConsentLeases,
  TAKEOVER_ESCALATION_TTL_MS,
  TakeoverEscalations,
  WINDOWS_EXPECTED_TOOLS,
  WINDOWS_SERVER_NAME,
  WINDOWS_TOOL_NAMES,
  buildWindowsApprovalPreview,
  classifyWindowsTool,
  createSensitiveWindowWatcher,
  escalateOnTakeover,
  outputIndicatesSensitiveWindow,
  revokeOnForegroundChange,
  targetReceiptOf,
  targetResultFactsOf,
} from './windows-mcp-classifier'
import type { LoopEvent } from '../../host-adapter/loop-events'
import type { ToolRiskContext } from '../tool-risk-classifier'
import type { WindowsLeaseGrant } from './windows-mcp-classifier'
import type { PermissionLevel } from '../../permission/permission-policy'

const ALL_LEVELS: readonly PermissionLevel[] = [
  'read_only',
  'ask',
  'workspace_write',
  'unrestricted',
]

function ctx(
  tool: string,
  input: Record<string, unknown> = {},
  level: PermissionLevel = 'workspace_write',
  at = 1_000,
  conversationId = 'conv-1',
): ToolRiskContext {
  return {
    profileId: 'work.core.v1',
    packageId: 'windows-mcp',
    toolName: `mcp__${WINDOWS_SERVER_NAME}__${tool}`,
    input,
    permissionLevel: level,
    projectRoot: 'D:/work/proj',
    conversationId,
    at,
  }
}

function consented(at = 1_000): ScreenConsentLeases {
  const leases = new ScreenConsentLeases()
  leases.grant(
    {
      kind: 'windows-screen',
      actionClass: 'windows-desktop',
      conversationId: 'conv-1',
      ttlMs: SCREEN_CONSENT_TTL_MS,
    },
    at,
  )
  return leases
}

describe('pinned surface (PR-6 §6.6)', () => {
  it('exposes exactly the 14 allowed tools with the trylo-windows prefix', () => {
    expect(WINDOWS_TOOL_NAMES).toHaveLength(14)
    expect(WINDOWS_EXPECTED_TOOLS).toHaveLength(14)
    for (const full of WINDOWS_EXPECTED_TOOLS) {
      expect(full.startsWith(`mcp__${WINDOWS_SERVER_NAME}__`)).toBe(true)
    }
  })

  it('every pinned tool produces a decision — none is unknown_tool (drift alarm)', () => {
    for (const tool of WINDOWS_TOOL_NAMES) {
      for (const level of ALL_LEVELS) {
        const route = classifyWindowsTool(ctx(tool, {}, level))
        // read_only denies several classes; nothing on the pinned surface
        // may fall through to unknown_tool.
        expect(route.reasonCode ?? '').not.toBe('unknown_tool')
      }
    }
  })
})

describe('screen reading (§6.6: 第一次需要屏幕读取同意，之后会话级 lease)', () => {
  const SCREEN_TOOLS = ['Screenshot', 'Snapshot', 'DisplayInventory', 'Ocr'] as const

  it('the first screen read is an approval that carries the consent lease', () => {
    for (const tool of SCREEN_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, { use_vision: true }, 'workspace_write'))
      expect(route.behavior).toBe('prompt')
      if (route.behavior === 'prompt') {
        expect(route.reasonCode).toBe('screen_consent_required')
        expect(route.lease?.kind).toBe('windows-screen')
      }
    }
  })

  it('with a live consent lease, screen reads auto-allow in the conversation', () => {
    const leases = consented()
    for (const tool of SCREEN_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, {}, 'workspace_write'), { screenConsent: leases })
      expect(route.behavior).toBe('auto_allow')
    }
  })

  it('a lease in ANOTHER conversation does not unlock this one', () => {
    const leases = consented()
    const route = classifyWindowsTool(ctx('Screenshot', {}, 'workspace_write', 1_000, 'conv-2'), {
      screenConsent: leases,
    })
    expect(route.behavior).toBe('prompt')
  })

  it('an expired lease falls back to the approval', () => {
    const leases = consented(1_000)
    const route = classifyWindowsTool(
      ctx('Screenshot', {}, 'workspace_write', 1_000 + SCREEN_CONSENT_TTL_MS + 1),
      {
        screenConsent: leases,
      },
    )
    expect(route.behavior).toBe('prompt')
  })

  it('read_only denies screen reading outright', () => {
    const route = classifyWindowsTool(ctx('Screenshot', {}, 'read_only'), {
      screenConsent: consented(),
    })
    expect(route.behavior).toBe('deny')
    expect(route.reasonCode).toBe('screen_denied_read_only')
  })
})

describe('ambient steering (§6.6: Move/Scroll/Wait/WaitFor 已授权桌面任务内可自动)', () => {
  const STEERING_TOOLS = ['Move', 'Scroll', 'Wait', 'WaitFor'] as const

  it('auto inside a consented desktop task', () => {
    const leases = consented()
    for (const tool of STEERING_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, tool === 'Wait' ? { duration: 2 } : {}), {
        screenConsent: leases,
      })
      expect(route.behavior).toBe('auto_allow')
    }
  })

  it('requires consent outside one (never auto without authorization)', () => {
    for (const tool of STEERING_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, {}))
      expect(route.behavior).toBe('prompt')
      expect(route.reasonCode).toBe('desktop_task_requires_consent')
    }
  })

  it('read_only denies steering (it drives the desktop)', () => {
    for (const tool of STEERING_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, {}, 'read_only'), { screenConsent: consented() })
      expect(route.behavior).toBe('deny')
    }
  })
})

describe('point interaction (§6.6: Click/MultiSelect 审批或 scoped lease)', () => {
  it('Click and MultiSelect prompt without a lease at ask/workspace_write, auto in unrestricted', () => {
    for (const level of ['ask', 'workspace_write'] as const) {
      const click = classifyWindowsTool(ctx('Click', { loc: [120, 90] }, level))
      expect(click.behavior).toBe('prompt')
      expect(click.reasonCode).toBe('click_requires_approval')
      const multi = classifyWindowsTool(ctx('MultiSelect', { locs: [[1, 2]] }, level))
      expect(multi.behavior).toBe('prompt')
    }
    // 完全自动下免审批
    for (const level of ['unrestricted'] as const) {
      const click = classifyWindowsTool(ctx('Click', { loc: [120, 90] }, level))
      expect(click.behavior).toBe('auto_allow')
      const multi = classifyWindowsTool(ctx('MultiSelect', { locs: [[1, 2]] }, level))
      expect(multi.behavior).toBe('auto_allow')
    }
  })

  it('a CLICK approval issues a click lease and the NEXT click auto-allows (audit fix)', () => {
    // Audit 2026-09-02: the lease used to be granted but never consulted —
    // the promised 5-minute click auto-allow never happened.
    const leases = new ScreenConsentLeases()
    const first = classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'workspace_write'), {
      screenConsent: leases,
    })
    expect(first.behavior).toBe('prompt')
    if (first.behavior === 'prompt') {
      expect(first.lease?.kind).toBe('windows-click')
      leases.grant(first.lease! as WindowsLeaseGrant, 1_000)
    }
    const second = classifyWindowsTool(ctx('Click', { loc: [3, 4] }, 'workspace_write'), {
      screenConsent: leases,
    })
    expect(second.behavior).toBe('auto_allow')
    expect(second.reasonCode).toBe('click_leased')
  })

  it('a click lease NEVER unlocks steering or screen reads (different human decision)', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      1_000,
    )
    const move = classifyWindowsTool(ctx('Move', {}, 'workspace_write'), { screenConsent: leases })
    expect(move.behavior).toBe('prompt')
    expect(move.reasonCode).toBe('desktop_task_requires_consent')
    const shot = classifyWindowsTool(ctx('Screenshot', {}, 'workspace_write'), {
      screenConsent: leases,
    })
    expect(shot.behavior).toBe('prompt')
    expect(shot.reasonCode).toBe('screen_consent_required')
  })

  it('a SCREEN consent does NOT unlock clicks', () => {
    const leases = consented()
    const click = classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'workspace_write'), {
      screenConsent: leases,
    })
    expect(click.behavior).toBe('prompt')
    expect(click.reasonCode).toBe('click_requires_approval')
  })

  it('read_only denies clicks (§6.3 点击/输入拒绝)', () => {
    const route = classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'read_only'))
    expect(route.behavior).toBe('deny')
    expect(route.reasonCode).toBe('interaction_denied_read_only')
  })

  it('emergency stop revokes BOTH lease kinds at once', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-screen',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      1_000,
    )
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      1_000,
    )
    leases.revokeConversation('conv-1')
    expect(leases.active('conv-1', 1_001)).toBe(false)
    expect(leases.activeScope('windows-click', 'conv-1', 1_001)).toBe(false)
  })
})

describe('high impact (§6.6: Type/Shortcut/App 高影响，首版逐次审批)', () => {
  it('requires per-call approval at ask/workspace_write, auto-allows in unrestricted (完全自动免审批), no lease', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['Type', { text: 'hello world' }],
      ['Shortcut', { shortcut: 'ctrl+s' }],
      ['App', { mode: 'launch', name: 'notepad' }],
      // Clipboard reads whatever the user last copied and plants content
      // they may paste elsewhere — same per-call approval class (2026-09-04).
      ['Clipboard', { mode: 'get' }],
      ['Clipboard', { mode: 'set', text: 'ZOOM\nE\n' }],
    ]
    for (const [tool, input] of cases) {
      for (const level of ALL_LEVELS) {
        const route = classifyWindowsTool(ctx(tool, input, level))
        if (level === 'read_only') {
          expect(route.behavior).toBe('deny')
        } else if (level === 'unrestricted') {
          expect(route.behavior).toBe('auto_allow')
          if (route.behavior === 'auto_allow') {
            expect(route.reasonCode).toBe('unrestricted')
          }
        } else {
          expect(route.behavior).toBe('prompt')
          if (route.behavior === 'prompt') {
            expect(route.reasonCode).toBe('high_impact_requires_approval')
            expect(route.lease).toBeUndefined()
          }
        }
      }
    }
  })
})

describe('sensitive window semantics (§6.6 敏感窗口策略)', () => {
  it('forces approval at EVERY level even with a live lease (bypass-immune) — 敏感语义仍强制审批，非敏感在 unrestricted 下放行', () => {
    const leases = consented()
    const cases: [string, Record<string, unknown>, boolean][] = [
      // [tool, input, deniedAtReadOnly] — the ambient steering class is
      // denied read_only via its own reason; high-impact tools too.
      // 前三项为高影响但非敏感（hunter2 等），在 ask/workspace_write 仍 prompt，在 unrestricted 下按用户“完全自动免审批”需求放行
      // 最后一项含支付敏感词，任何级别都强制审批（含 unrestricted）
      ['Type', { text: 'hunter2' }, true],
      ['Shortcut', { shortcut: 'ctrl+shift+esc' }, true],
      ['App', { mode: 'launch', name: 'Task Manager' }, true],
      ['WaitFor', { condition: 'text_exists', text: '支付成功' }, false],
    ]
    for (const [tool, input, deniedAtReadOnly] of cases) {
      for (const level of ALL_LEVELS) {
        const route = classifyWindowsTool(ctx(tool, input, level), { screenConsent: leases })
        if (level === 'read_only') {
          expect(route.behavior).toBe(deniedAtReadOnly ? 'deny' : 'prompt')
        } else if (level === 'unrestricted') {
          // A 完全自动：unrestricted 下一律放行（含敏感）
          expect(route.behavior).toBe('auto_allow')
        } else {
          // 敏感目标或 ask/workspace_write 下的高影响 — 强制审批，lease 永不覆盖
          expect(route.behavior).toBe('prompt')
          if (route.behavior === 'prompt') {
            expect(['sensitive_target', 'high_impact_requires_approval']).toContain(
              route.reasonCode,
            )
            expect(route.lease).toBeUndefined()
          }
        }
      }
    }
  })

  it('a UAC/admin window target cannot ride an auto-allow — except in unrestricted (A 完全自动)', () => {
    const leases = consented()
    const route = classifyWindowsTool(
      ctx('WaitFor', { condition: 'active_window', window_name: '用户账户控制' }, 'unrestricted'),
      {
        screenConsent: leases,
      },
    )
    expect(route.behavior).toBe('auto_allow')
  })
})

describe('input hygiene (§6.2/§14.2)', () => {
  it('malformed input denies outright', () => {
    const route = classifyWindowsTool(
      ctx('Click', { loc: 'not-a-thing' as unknown as Record<string, unknown> }),
    )
    // loc is a documented field with a wrong type — the classifier only
    // fails closed on non-record inputs; a wrong-typed field is still a
    // parse problem per §6.2.
    expect(['deny', 'prompt']).toContain(route.behavior)
  })

  it('a non-record input is a hard deny', () => {
    const route = classifyWindowsTool(ctx('Click', null as unknown as Record<string, unknown>))
    expect(route.behavior).toBe('deny')
    expect(route.reasonCode).toBe('malformed_input')
  })

  it('oversized inputs are never auto except in unrestricted (A 完全自动放行)', () => {
    const leases = consented()
    const big: Record<string, unknown> = { text: 'x'.repeat(300 * 1024) }
    const route = classifyWindowsTool(ctx('Type', big, 'unrestricted'), { screenConsent: leases })
    expect(route.behavior).toBe('auto_allow')
    // non-unrestricted still prompts
    const route2 = classifyWindowsTool(ctx('Type', big, 'workspace_write'), {
      screenConsent: leases,
    })
    expect(route2.behavior).toBe('prompt')
    expect(route2.reasonCode).toBe('input_too_large')
  })
})

describe('consent store behaviour', () => {
  it('revokeConversation drops exactly one conversation', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-screen',
        actionClass: 'windows-desktop',
        conversationId: 'a',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      0,
    )
    leases.grant(
      {
        kind: 'windows-screen',
        actionClass: 'windows-desktop',
        conversationId: 'b',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      0,
    )
    leases.revokeConversation('a')
    expect(leases.active('a', 1)).toBe(false)
    expect(leases.active('b', 1)).toBe(true)
  })

  it('revokeAll drops everything (global emergency stop)', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-screen',
        actionClass: 'windows-desktop',
        conversationId: 'a',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      0,
    )
    leases.grant(
      {
        kind: 'windows-screen',
        actionClass: 'windows-desktop',
        conversationId: 'b',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      0,
    )
    leases.revokeAll()
    expect(leases.active('a', 1)).toBe(false)
    expect(leases.active('b', 1)).toBe(false)
  })

  it('a re-approval resets the TTL (a fresh human decision)', () => {
    const leases = new ScreenConsentLeases()
    const ttl = 1_000
    leases.grant(
      { kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'a', ttlMs: ttl },
      0,
    )
    leases.grant(
      { kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'a', ttlMs: ttl },
      500,
    )
    expect(leases.active('a', 1_400)).toBe(true)
    expect(leases.active('a', 1_600)).toBe(false)
  })
})

describe('safe preview (§6.2 redaction)', () => {
  it('never echoes typed text, shortcut combos or app names', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['Type', { text: 'super-secret-password' }],
      ['Shortcut', { shortcut: 'win+r' }],
      ['App', { mode: 'launch_executable', executable: 'C:/Windows/System32/cmd.exe' }],
    ]
    for (const [tool, input] of cases) {
      const preview = buildWindowsApprovalPreview({
        toolName: `mcp__${WINDOWS_SERVER_NAME}__${tool}`,
        input,
      })
      expect(JSON.stringify(preview)).not.toContain('super-secret-password')
      expect(JSON.stringify(preview)).not.toContain('win+r')
      expect(JSON.stringify(preview)).not.toContain('cmd.exe')
    }
  })

  it('shows the target shape for clicks', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Click`,
      input: { loc: [120, 90] },
    })
    expect(preview.target).toContain('120,90')
    // The 2026-09-03 computer-use visual block: an action label + a mini
    // screen render on the card instead of a bare summary row.
    expect(preview.kind).toBe('desktop')
    expect((preview as { actionLabel?: string }).actionLabel).toBe('桌面点击 / 选择')
  })

  it('reports the typed LENGTH, never the text (C06)', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Type`,
      input: { text: 'super-secret-password' },
    }) as { textChars?: number }
    expect(preview.textChars).toBe('super-secret-password'.length)
    expect(JSON.stringify(preview)).not.toContain('super-secret-password')
  })

  it('Clipboard set previews show only the LENGTH, never the payload', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Clipboard`,
      input: { mode: 'set', text: 'secret-drawing-script' },
    }) as { textChars?: number; actionLabel?: string }
    expect(preview.textChars).toBe('secret-drawing-script'.length)
    expect(preview.actionLabel).toBe('剪贴板（内容已隐藏）')
    expect(JSON.stringify(preview)).not.toContain('secret-drawing-script')
  })

  it('Ocr previews describe the screen region (screen-read class)', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Ocr`,
      input: { region: [0, 1300, 400, 1400] },
    })
    expect(preview.target).toContain('0,1300,400,1400')
  })

  it('never throws on unexpected input', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Click`,
      input: null as unknown as Record<string, unknown>,
    })
    expect(preview.kind).toBe('desktop')
  })
})

// ── PR-6 偏差③收口: output-side sensitive-window recognition ──────────

function toolUse(id: string, toolName: string): import('../../host-adapter/loop-events').LoopEvent {
  return { type: 'tool_use', seq: 1, ts: 1, turn: 1, id, tool: toolName, input: {} } as never
}

function toolResult(
  id: string,
  output: string,
): import('../../host-adapter/loop-events').LoopEvent {
  return {
    type: 'tool_result',
    seq: 2,
    ts: 2,
    turn: 1,
    id,
    tool: '',
    ok: true,
    output,
    durationMs: 1,
  } as never
}

describe('output-side sensitive-window recognition (§6.6 偏差③收口)', () => {
  it('detects UAC / elevated-window markers in result text', () => {
    for (const text of [
      '窗口: 用户账户控制',
      'Window: User Account Control',
      '标题: 管理员: 命令提示符',
      'Administrator: Windows PowerShell',
      '进程 consent.exe 正在运行',
    ]) {
      expect(outputIndicatesSensitiveWindow(text)).toBe(true)
    }
    for (const text of ['', undefined, null, '记事本 - 无标题', 'Chrome 百度搜索结果页']) {
      expect(outputIndicatesSensitiveWindow(text as string)).toBe(false)
    }
  })

  it('revokes the conversation consent when a screen read shows a UAC window', () => {
    const leases = consented()
    const watcher = createSensitiveWindowWatcher(leases)
    // The tool_use and its result arrive in DIFFERENT batches — the watcher
    // must track the in-flight call across batches.
    expect(watcher([toolUse('tu-1', `mcp__${WINDOWS_SERVER_NAME}__Snapshot`)], 'conv-1')).toBe(
      false,
    )
    expect(leases.active('conv-1', 1_000)).toBe(true)
    expect(watcher([toolResult('tu-1', '窗口列表: [用户账户控制] 是(Y) 否(N)')], 'conv-1')).toBe(
      true,
    )
    // 拒绝自动化: the lease is gone — steering and screen reads re-prompt.
    expect(leases.active('conv-1', 1_000)).toBe(false)
    const route = classifyWindowsTool(ctx('Move', {}, 'workspace_write'), { screenConsent: leases })
    expect(route.behavior).toBe('prompt')
    expect(route.reasonCode).toBe('desktop_task_requires_consent')
  })

  it('ordinary result text keeps the lease alive', () => {
    const leases = consented()
    const watcher = createSensitiveWindowWatcher(leases)
    watcher([toolUse('tu-2', `mcp__${WINDOWS_SERVER_NAME}__Screenshot`)], 'conv-1')
    expect(watcher([toolResult('tu-2', '屏幕截图完成（1.2 MB）')], 'conv-1')).toBe(false)
    expect(leases.active('conv-1', 1_000)).toBe(true)
  })

  it('only trylo-windows results can trigger revocation', () => {
    const leases = consented()
    const watcher = createSensitiveWindowWatcher(leases)
    watcher([toolUse('tu-3', 'mcp__trylo-browser__browser_snapshot')], 'conv-1')
    expect(watcher([toolResult('tu-3', 'User Account Control dialog found')], 'conv-1')).toBe(false)
    expect(leases.active('conv-1', 1_000)).toBe(true)
  })

  it('revocation is scoped to the conversation', () => {
    const leases = consented()
    leases.grant(
      {
        kind: 'windows-screen',
        actionClass: 'windows-desktop',
        conversationId: 'conv-2',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      1_000,
    )
    const watcher = createSensitiveWindowWatcher(leases)
    watcher([toolUse('tu-4', `mcp__${WINDOWS_SERVER_NAME}__Snapshot`)], 'conv-1')
    watcher([toolResult('tu-4', '管理员: 注册表编辑器')], 'conv-1')
    expect(leases.active('conv-1', 1_000)).toBe(false)
    expect(leases.active('conv-2', 1_000)).toBe(true)
  })
})

// ── WCC-P2-01: target-scoped leases ──────────────────────────────────────

describe('target receipts (WCC-P2-01)', () => {
  const WINDOW_A = {
    hwnd: 111,
    pid: 4200,
    processStartedAt100ns: 133000000000000000,
    digest: 'win-a-digest',
    title: '记事本',
  }
  const WINDOW_B = { hwnd: 222, pid: 5100, digest: 'win-b-digest', title: '计算器' }

  it('targetReceiptOf reads a well-formed _target envelope and rejects malformed ones', () => {
    expect(targetReceiptOf({ _target: { window: WINDOW_A } })).toMatchObject({
      hwnd: 111,
      pid: 4200,
      digest: 'win-a-digest',
    })
    expect(
      targetReceiptOf({ _target: { window: { ...WINDOW_A, title: 'x'.repeat(500) } } })?.title,
    ).toHaveLength(200)
    // Malformed shapes → null (never a guessed window scope):
    expect(targetReceiptOf({})).toBeNull()
    expect(targetReceiptOf({ _target: {} })).toBeNull()
    expect(targetReceiptOf({ _target: { window: { hwnd: 'x', pid: 1, digest: 'd' } } })).toBeNull()
    expect(targetReceiptOf({ _target: { window: { hwnd: 0, pid: 1, digest: 'd' } } })).toBeNull()
    expect(targetReceiptOf({ _target: { window: { hwnd: -5, pid: 1, digest: 'd' } } })).toBeNull()
    expect(targetReceiptOf({ _target: { window: { hwnd: 1.5, pid: 1, digest: 'd' } } })).toBeNull()
    expect(targetReceiptOf({ _target: { window: { hwnd: 1, pid: 1, digest: '' } } })).toBeNull()
    expect(
      targetReceiptOf({ _target: { window: { hwnd: 1, pid: 1, digest: 'd'.repeat(129) } } }),
    ).toBeNull()
    expect(targetReceiptOf({ _target: { window: { hwnd: 1, pid: 1 } } })).toBeNull()
  })

  it('targetReceiptOf reads the model-facing window_receipt parameter (WCC-P2-02)', () => {
    // The model copies a Snapshot Window Receipt verbatim into the
    // window_receipt param; the classifier must scope the lease to it.
    expect(targetReceiptOf({ window_receipt: WINDOW_A })).toMatchObject({
      hwnd: 111,
      digest: 'win-a-digest',
    })
    expect(targetReceiptOf({ window_receipt: { hwnd: 0, pid: 1, digest: 'd' } })).toBeNull()
    expect(targetReceiptOf({ window_receipt: 'win-a-digest' })).toBeNull()
    // The envelope wins when both carriers are present.
    expect(
      targetReceiptOf({ _target: { window: WINDOW_A }, window_receipt: { ...WINDOW_B } })?.digest,
    ).toBe('win-a-digest')
  })

  it('a window_receipt param activates the window-scoped click lease at classification time', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    // The same window receipt auto-allows…
    const same = classifyWindowsTool(
      ctx('Click', { window_receipt: WINDOW_A }, 'workspace_write'),
      { screenConsent: leases },
    )
    expect(same.behavior).toBe('auto_allow')
    // …and a different window's receipt prompts (preventive scoping, no
    // executed-result needed).
    const other = classifyWindowsTool(
      ctx('Click', { window_receipt: WINDOW_B }, 'workspace_write'),
      { screenConsent: leases },
    )
    expect(other.behavior).toBe('prompt')
  })

  it('a click approval for window A carries A\u2019s receipt in the lease', () => {
    const input = { window: '记事本', _target: { window: WINDOW_A } }
    const route = classifyWindowsTool(ctx('Click', input, 'workspace_write'))
    expect(route.behavior).toBe('prompt')
    if (route.behavior === 'prompt') {
      expect(route.lease?.kind).toBe('windows-click')
      const lease = route.lease as WindowsLeaseGrant
      expect(lease.window?.digest).toBe('win-a-digest')
      expect(lease.window?.hwnd).toBe(111)
      expect(lease.window?.pid).toBe(4200)
    }
  })

  it('a window-A click lease does NOT auto-allow a window-B click (A-13 fix)', () => {
    const leases = new ScreenConsentLeases()
    // The user approved a click on window A only.
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    const clickB = classifyWindowsTool(
      ctx('Click', { window: '计算器', _target: { window: WINDOW_B } }, 'workspace_write'),
      { screenConsent: leases },
    )
    expect(clickB.behavior).toBe('prompt')
    expect(clickB.reasonCode).toBe('click_requires_approval')
    // The same window still auto-allows.
    const clickA = classifyWindowsTool(
      ctx('Click', { window: '记事本', _target: { window: WINDOW_A } }, 'workspace_write'),
      { screenConsent: leases },
    )
    expect(clickA.behavior).toBe('auto_allow')
    expect(clickA.reasonCode).toBe('click_leased_window')
  })

  it('a window-scoped lease does not unlock a receipt-less click, and vice versa the legacy lease still covers the conversation', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    // A request without a resolved target is NOT covered by a window lease.
    const legacy = classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'workspace_write'), {
      screenConsent: leases,
    })
    expect(legacy.behavior).toBe('prompt')
    // But a legacy (conversation-scoped) grant still covers both shapes —
    // the user approved without a window on the card.
    const legacyLeases = new ScreenConsentLeases()
    legacyLeases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      1_000,
    )
    expect(
      classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'workspace_write'), {
        screenConsent: legacyLeases,
      }).behavior,
    ).toBe('auto_allow')
    expect(
      classifyWindowsTool(ctx('Click', { _target: { window: WINDOW_B } }, 'workspace_write'), {
        screenConsent: legacyLeases,
      }).behavior,
    ).toBe('auto_allow')
  })

  it('PID reuse cannot inherit a lease: a different start time is a different decision', () => {
    // Same PID + same digest is the server's identity contract; the receipt
    // digest differs when the process restarted (the server computes it from
    // PID + start time), so the new generation hits a new scope key.
    const restarted = {
      ...WINDOW_A,
      processStartedAt100ns: 134000000000000000,
      digest: 'win-a-digest-2',
    }
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    const afterRestart = classifyWindowsTool(
      ctx('Click', { _target: { window: restarted } }, 'workspace_write'),
      { screenConsent: leases },
    )
    expect(afterRestart.behavior).toBe('prompt')
  })

  it('emergency stop revokes window-scoped leases with the conversation', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    leases.revokeConversation('conv-1')
    expect(
      classifyWindowsTool(ctx('Click', { _target: { window: WINDOW_A } }, 'workspace_write'), {
        screenConsent: leases,
      }).behavior,
    ).toBe('prompt')
  })

  it('a FOREGROUND CHANGE to another window revokes the window-scoped lease (revokeOn: foreground_changed)', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    // The user (or the OS) moved focus elsewhere: the granted window is no
    // longer the foreground window, so its scoped lease dies.
    leases.revokeScopeFor('win-b-digest')
    expect(
      classifyWindowsTool(ctx('Click', { _target: { window: WINDOW_A } }, 'workspace_write'), {
        screenConsent: leases,
      }).behavior,
    ).toBe('prompt')
    // A null foreground (server could not tell) must NOT revoke anything.
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    leases.revokeScopeFor(null)
    expect(
      classifyWindowsTool(ctx('Click', { _target: { window: WINDOW_A } }, 'workspace_write'), {
        screenConsent: leases,
      }).behavior,
    ).toBe('auto_allow')
    // The foreground window's OWN lease survives (acting in the window the
    // user is looking at is the granted context).
    leases.revokeScopeFor('win-a-digest')
    expect(
      classifyWindowsTool(ctx('Click', { _target: { window: WINDOW_A } }, 'workspace_write'), {
        screenConsent: leases,
      }).behavior,
    ).toBe('auto_allow')
  })

  it('a foreground change does not touch conversation-scoped (legacy) leases', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      1_000,
    )
    leases.revokeScopeFor('some-other-window')
    expect(
      classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'workspace_write'), {
        screenConsent: leases,
      }).behavior,
    ).toBe('auto_allow')
  })

  it('revokeOnForegroundChange withdraws scopes from a server-reported result block', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    const events: readonly LoopEvent[] = [
      {
        type: 'tool_result',
        turn: 1,
        id: 'tr-1',
        tool: `mcp__${WINDOWS_SERVER_NAME}__Click`,
        ok: true,
        output: 'clicked',
        durationMs: 10,
        content: [{ type: 'text', text: 'trylo-target:{"foregroundDigest":"win-b-digest"}' }],
      } as unknown as LoopEvent,
    ]
    expect(revokeOnForegroundChange(leases, events, 'conv-1')).toBe(true)
    expect(
      classifyWindowsTool(ctx('Click', { _target: { window: WINDOW_A } }, 'workspace_write'), {
        screenConsent: leases,
      }).behavior,
    ).toBe('prompt')
  })

  it('revokeOnForegroundChange ignores malformed/foreign result blocks', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    const events: readonly LoopEvent[] = [
      {
        type: 'tool_result',
        turn: 1,
        id: 'tr-2',
        tool: `mcp__${WINDOWS_SERVER_NAME}__Click`,
        ok: true,
        output: 'x',
        durationMs: 1,
        content: [
          { type: 'text', text: 'trylo-target:not-json' },
          { type: 'text', text: 'trylo-target:{"foregroundDigest":42}' },
          { type: 'text', text: 'totally normal output' },
        ],
      } as unknown as LoopEvent,
      {
        type: 'tool_result',
        turn: 1,
        id: 'tr-3',
        tool: 'mcp__trylo-browser__browser_navigate',
        ok: true,
        output: 'y',
        durationMs: 1,
        content: [{ type: 'text', text: 'trylo-target:{"foregroundDigest":"evil"}' }],
      } as unknown as LoopEvent,
    ]
    expect(revokeOnForegroundChange(leases, events, 'conv-1')).toBe(false)
    expect(
      classifyWindowsTool(ctx('Click', { _target: { window: WINDOW_A } }, 'workspace_write'), {
        screenConsent: leases,
      }).behavior,
    ).toBe('auto_allow')
  })

  it('the approval summary shows the resolved window, not the model\u2019s free-text claim (A-15 fix)', () => {
    const input = { loc: [120, 90], window: '记事本', _target: { window: WINDOW_A } }
    const preview = buildWindowsApprovalPreview({ toolName: 'mcp__trylo-windows__Click', input })
    expect(preview.target).toBe('记事本 · 120,90')
    // Without a receipt the legacy summary stands.
    const plain = buildWindowsApprovalPreview({
      toolName: 'mcp__trylo-windows__Click',
      input: { loc: [120, 90] },
    })
    expect(plain.target).toBe('120,90')
  })

  it('a model-authored window title never changes the lease scope (digest keys it)', () => {
    const leases = new ScreenConsentLeases()
    leases.grant(
      {
        kind: 'windows-click',
        actionClass: 'windows-desktop',
        conversationId: 'conv-1',
        ttlMs: SCREEN_CONSENT_TTL_MS,
        window: WINDOW_A,
      },
      1_000,
    )
    // The model renames the window; the receipt digest is unchanged, so the
    // lease still applies (scope is identity, not display text).
    const renamed = classifyWindowsTool(
      ctx('Click', { window: '完全不同的名字', _target: { window: WINDOW_A } }, 'workspace_write'),
      { screenConsent: leases },
    )
    expect(renamed.behavior).toBe('auto_allow')
  })

  it('sensitive text in window/element free-text fields forces approval (A-15 补收口)', () => {
    // `window` and `element` were not in TARGET_TEXT_FIELDS before: a click
    // naming a UAC window through them slipped past sensitive-target checks.
    const route = classifyWindowsTool(ctx('Click', { window: '用户账户控制' }, 'workspace_write'), {
      screenConsent: consented(),
    })
    expect(route.behavior).toBe('prompt')
    expect(route.reasonCode).toBe('sensitive_target')
    const elementRoute = classifyWindowsTool(
      ctx('Click', { element: '管理员: 设备管理器' }, 'workspace_write'),
      {
        screenConsent: consented(),
      },
    )
    expect(elementRoute.reasonCode).toBe('sensitive_target')
  })
})

// ── §11.3 用户接管 (WCC-P2-04): escalation store + forced approvals ─────

describe('takeover escalation (§11.3 用户接管, WCC-P2-04)', () => {
  function factsResult(
    id: string,
    takeover: string,
  ): import('../../host-adapter/loop-events').LoopEvent {
    const facts = `trylo-target:${JSON.stringify({
      window: { hwnd: 42, pid: 4242, digest: 'win-digest', title: '记事本' },
      foregroundDigest: 'win-digest',
      dispatch: 'accepted',
      effect: 'unknown_outcome',
      takeover,
    })}`
    return {
      type: 'tool_result',
      seq: 3,
      ts: 3,
      turn: 1,
      id,
      tool: `mcp__${WINDOWS_SERVER_NAME}__Click`,
      ok: true,
      output: facts,
      durationMs: 1,
    } as never
  }

  it('escalateOnTakeover records the conversation from a takeover fact', () => {
    const escalations = new TakeoverEscalations()
    expect(escalations.active('conv-1', 1_000)).toBe(false)
    expect(escalateOnTakeover(escalations, [factsResult('r-1', 'yielded')], 'conv-1')).toBe(true)
    expect(escalations.active('conv-1', 1_000)).toBe(true)
    // Scoped to the conversation.
    expect(escalations.active('conv-2', 1_000)).toBe(false)
  })

  it('an escalation forces per-call approvals on EVERY windows tool, lease or not', () => {
    const escalations = new TakeoverEscalations()
    escalations.record('conv-1', 1_000)
    const leases = consented(1_000)
    for (const tool of ['Snapshot', 'Move', 'Click', 'Type', 'Clipboard']) {
      const route = classifyWindowsTool(ctx(tool, {}, 'workspace_write', 1_000, 'conv-1'), {
        screenConsent: leases,
        takeoverEscalations: escalations,
      })
      expect(route.behavior).toBe('prompt')
      expect(route.reasonCode).toBe('takeover_requires_approval')
    }
    // Another conversation keeps its lease semantics (Move is leased there
    // by its own consent grant — this one is granted for conv-2).
    const leases2 = new ScreenConsentLeases()
    leases2.grant(
      {
        kind: 'windows-screen',
        actionClass: 'windows-desktop',
        conversationId: 'conv-2',
        ttlMs: SCREEN_CONSENT_TTL_MS,
      },
      1_000,
    )
    const other = classifyWindowsTool(ctx('Move', {}, 'workspace_write', 1_000, 'conv-2'), {
      screenConsent: leases2,
      takeoverEscalations: escalations,
    })
    expect(other.behavior).toBe('auto_allow')
  })

  it('the escalation expires with its TTL and never covers other conversations', () => {
    const escalations = new TakeoverEscalations()
    escalations.record('conv-1', 1_000)
    expect(escalations.active('conv-1', 1_000 + TAKEOVER_ESCALATION_TTL_MS - 1)).toBe(true)
    expect(escalations.active('conv-1', 1_000 + TAKEOVER_ESCALATION_TTL_MS)).toBe(false)
  })

  it('a result WITHOUT a takeover fact does not escalate', () => {
    const escalations = new TakeoverEscalations()
    const plain = {
      type: 'tool_result',
      seq: 3,
      ts: 3,
      turn: 1,
      id: 'r-2',
      tool: `mcp__${WINDOWS_SERVER_NAME}__Click`,
      ok: true,
      output: 'Single left clicked at (1,2).',
      durationMs: 1,
    } as never
    expect(escalateOnTakeover(escalations, [plain], 'conv-1')).toBe(false)
    expect(escalations.active('conv-1', 1_000)).toBe(false)
  })

  it('targetResultFactsOf parses the takeover field', () => {
    const facts = targetResultFactsOf([
      { type: 'text', text: (factsResult('r-3', 'safe_release') as { output: string }).output },
    ])
    expect(facts?.takeover).toBe('safe_release')
  })
})
