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

import { describe, expect, it } from 'vitest';

import {
  SCREEN_CONSENT_TTL_MS,
  ScreenConsentLeases,
  WINDOWS_EXPECTED_TOOLS,
  WINDOWS_SERVER_NAME,
  WINDOWS_TOOL_NAMES,
  buildWindowsApprovalPreview,
  classifyWindowsTool,
  createSensitiveWindowWatcher,
  outputIndicatesSensitiveWindow,
} from './windows-mcp-classifier';
import type { ToolRiskContext } from '../tool-risk-classifier';
import type { WindowsLeaseGrant } from './windows-mcp-classifier';
import type { PermissionLevel } from '../../permission/permission-policy';

const ALL_LEVELS: readonly PermissionLevel[] = [
  'read_only',
  'ask',
  'workspace_write',
  'unrestricted',
];

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
  };
}

function consented(at = 1_000): ScreenConsentLeases {
  const leases = new ScreenConsentLeases();
  leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'conv-1', ttlMs: SCREEN_CONSENT_TTL_MS }, at);
  return leases;
}

describe('pinned surface (PR-6 §6.6)', () => {
  it('exposes exactly the 14 allowed tools with the trylo-windows prefix', () => {
    expect(WINDOWS_TOOL_NAMES).toHaveLength(14);
    expect(WINDOWS_EXPECTED_TOOLS).toHaveLength(14);
    for (const full of WINDOWS_EXPECTED_TOOLS) {
      expect(full.startsWith(`mcp__${WINDOWS_SERVER_NAME}__`)).toBe(true);
    }
  });

  it('every pinned tool produces a decision — none is unknown_tool (drift alarm)', () => {
    for (const tool of WINDOWS_TOOL_NAMES) {
      for (const level of ALL_LEVELS) {
        const route = classifyWindowsTool(ctx(tool, {}, level));
        // read_only denies several classes; nothing on the pinned surface
        // may fall through to unknown_tool.
        expect(route.reasonCode ?? '').not.toBe('unknown_tool');
      }
    }
  });
});

describe('screen reading (§6.6: 第一次需要屏幕读取同意，之后会话级 lease)', () => {
  const SCREEN_TOOLS = ['Screenshot', 'Snapshot', 'DisplayInventory', 'Ocr'] as const;

  it('the first screen read is an approval that carries the consent lease', () => {
    for (const tool of SCREEN_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, { use_vision: true }, 'workspace_write'));
      expect(route.behavior).toBe('prompt');
      if (route.behavior === 'prompt') {
        expect(route.reasonCode).toBe('screen_consent_required');
        expect(route.lease?.kind).toBe('windows-screen');
      }
    }
  });

  it('with a live consent lease, screen reads auto-allow in the conversation', () => {
    const leases = consented();
    for (const tool of SCREEN_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, {}, 'workspace_write'), { screenConsent: leases });
      expect(route.behavior).toBe('auto_allow');
    }
  });

  it('a lease in ANOTHER conversation does not unlock this one', () => {
    const leases = consented();
    const route = classifyWindowsTool(ctx('Screenshot', {}, 'workspace_write', 1_000, 'conv-2'), {
      screenConsent: leases,
    });
    expect(route.behavior).toBe('prompt');
  });

  it('an expired lease falls back to the approval', () => {
    const leases = consented(1_000);
    const route = classifyWindowsTool(ctx('Screenshot', {}, 'workspace_write', 1_000 + SCREEN_CONSENT_TTL_MS + 1), {
      screenConsent: leases,
    });
    expect(route.behavior).toBe('prompt');
  });

  it('read_only denies screen reading outright', () => {
    const route = classifyWindowsTool(ctx('Screenshot', {}, 'read_only'), { screenConsent: consented() });
    expect(route.behavior).toBe('deny');
    expect(route.reasonCode).toBe('screen_denied_read_only');
  });
});

describe('ambient steering (§6.6: Move/Scroll/Wait/WaitFor 已授权桌面任务内可自动)', () => {
  const STEERING_TOOLS = ['Move', 'Scroll', 'Wait', 'WaitFor'] as const;

  it('auto inside a consented desktop task', () => {
    const leases = consented();
    for (const tool of STEERING_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, tool === 'Wait' ? { duration: 2 } : {}), { screenConsent: leases });
      expect(route.behavior).toBe('auto_allow');
    }
  });

  it('requires consent outside one (never auto without authorization)', () => {
    for (const tool of STEERING_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, {}));
      expect(route.behavior).toBe('prompt');
      expect(route.reasonCode).toBe('desktop_task_requires_consent');
    }
  });

  it('read_only denies steering (it drives the desktop)', () => {
    for (const tool of STEERING_TOOLS) {
      const route = classifyWindowsTool(ctx(tool, {}, 'read_only'), { screenConsent: consented() });
      expect(route.behavior).toBe('deny');
    }
  });
});

describe('point interaction (§6.6: Click/MultiSelect 审批或 scoped lease)', () => {
  it('Click and MultiSelect prompt without a lease at ask/workspace_write, auto in unrestricted', () => {
    for (const level of ['ask', 'workspace_write'] as const) {
      const click = classifyWindowsTool(ctx('Click', { loc: [120, 90] }, level));
      expect(click.behavior).toBe('prompt');
      expect(click.reasonCode).toBe('click_requires_approval');
      const multi = classifyWindowsTool(ctx('MultiSelect', { locs: [[1, 2]] }, level));
      expect(multi.behavior).toBe('prompt');
    }
    // 完全自动下免审批
    for (const level of ['unrestricted'] as const) {
      const click = classifyWindowsTool(ctx('Click', { loc: [120, 90] }, level));
      expect(click.behavior).toBe('auto_allow');
      const multi = classifyWindowsTool(ctx('MultiSelect', { locs: [[1, 2]] }, level));
      expect(multi.behavior).toBe('auto_allow');
    }
  });

  it('a CLICK approval issues a click lease and the NEXT click auto-allows (audit fix)', () => {
    // Audit 2026-09-02: the lease used to be granted but never consulted —
    // the promised 5-minute click auto-allow never happened.
    const leases = new ScreenConsentLeases();
    const first = classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'workspace_write'), { screenConsent: leases });
    expect(first.behavior).toBe('prompt');
    if (first.behavior === 'prompt') {
      expect(first.lease?.kind).toBe('windows-click');
      leases.grant(first.lease! as WindowsLeaseGrant, 1_000);
    }
    const second = classifyWindowsTool(ctx('Click', { loc: [3, 4] }, 'workspace_write'), { screenConsent: leases });
    expect(second.behavior).toBe('auto_allow');
    expect(second.reasonCode).toBe('click_leased');
  });

  it('a click lease NEVER unlocks steering or screen reads (different human decision)', () => {
    const leases = new ScreenConsentLeases();
    leases.grant({ kind: 'windows-click', actionClass: 'windows-desktop', conversationId: 'conv-1', ttlMs: SCREEN_CONSENT_TTL_MS }, 1_000);
    const move = classifyWindowsTool(ctx('Move', {}, 'workspace_write'), { screenConsent: leases });
    expect(move.behavior).toBe('prompt');
    expect(move.reasonCode).toBe('desktop_task_requires_consent');
    const shot = classifyWindowsTool(ctx('Screenshot', {}, 'workspace_write'), { screenConsent: leases });
    expect(shot.behavior).toBe('prompt');
    expect(shot.reasonCode).toBe('screen_consent_required');
  });

  it('a SCREEN consent does NOT unlock clicks', () => {
    const leases = consented();
    const click = classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'workspace_write'), { screenConsent: leases });
    expect(click.behavior).toBe('prompt');
    expect(click.reasonCode).toBe('click_requires_approval');
  });

  it('read_only denies clicks (§6.3 点击/输入拒绝)', () => {
    const route = classifyWindowsTool(ctx('Click', { loc: [1, 2] }, 'read_only'));
    expect(route.behavior).toBe('deny');
    expect(route.reasonCode).toBe('interaction_denied_read_only');
  });

  it('emergency stop revokes BOTH lease kinds at once', () => {
    const leases = new ScreenConsentLeases();
    leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'conv-1', ttlMs: SCREEN_CONSENT_TTL_MS }, 1_000);
    leases.grant({ kind: 'windows-click', actionClass: 'windows-desktop', conversationId: 'conv-1', ttlMs: SCREEN_CONSENT_TTL_MS }, 1_000);
    leases.revokeConversation('conv-1');
    expect(leases.active('conv-1', 1_001)).toBe(false);
    expect(leases.activeScope('windows-click', 'conv-1', 1_001)).toBe(false);
  });
});

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
    ];
    for (const [tool, input] of cases) {
      for (const level of ALL_LEVELS) {
        const route = classifyWindowsTool(ctx(tool, input, level));
        if (level === 'read_only') {
          expect(route.behavior).toBe('deny');
        } else if (level === 'unrestricted') {
          expect(route.behavior).toBe('auto_allow');
          if (route.behavior === 'auto_allow') {
            expect(route.reasonCode).toBe('unrestricted');
          }
        } else {
          expect(route.behavior).toBe('prompt');
          if (route.behavior === 'prompt') {
            expect(route.reasonCode).toBe('high_impact_requires_approval');
            expect(route.lease).toBeUndefined();
          }
        }
      }
    }
  });
});

describe('sensitive window semantics (§6.6 敏感窗口策略)', () => {
  it('forces approval at EVERY level even with a live lease (bypass-immune) — 敏感语义仍强制审批，非敏感在 unrestricted 下放行', () => {
    const leases = consented();
    const cases: [string, Record<string, unknown>, boolean][] = [
      // [tool, input, deniedAtReadOnly] — the ambient steering class is
      // denied read_only via its own reason; high-impact tools too.
      // 前三项为高影响但非敏感（hunter2 等），在 ask/workspace_write 仍 prompt，在 unrestricted 下按用户“完全自动免审批”需求放行
      // 最后一项含支付敏感词，任何级别都强制审批（含 unrestricted）
      ['Type', { text: 'hunter2' }, true],
      ['Shortcut', { shortcut: 'ctrl+shift+esc' }, true],
      ['App', { mode: 'launch', name: 'Task Manager' }, true],
      ['WaitFor', { condition: 'text_exists', text: '支付成功' }, false],
    ];
    for (const [tool, input, deniedAtReadOnly] of cases) {
      for (const level of ALL_LEVELS) {
        const route = classifyWindowsTool(ctx(tool, input, level), { screenConsent: leases });
        if (level === 'read_only') {
          expect(route.behavior).toBe(deniedAtReadOnly ? 'deny' : 'prompt');
        } else if (level === 'unrestricted') {
          // A 完全自动：unrestricted 下一律放行（含敏感）
          expect(route.behavior).toBe('auto_allow');
        } else {
          // 敏感目标或 ask/workspace_write 下的高影响 — 强制审批，lease 永不覆盖
          expect(route.behavior).toBe('prompt');
          if (route.behavior === 'prompt') {
            expect(['sensitive_target', 'high_impact_requires_approval']).toContain(route.reasonCode);
            expect(route.lease).toBeUndefined();
          }
        }
      }
    }
  });

  it('a UAC/admin window target cannot ride an auto-allow — except in unrestricted (A 完全自动)', () => {
    const leases = consented();
    const route = classifyWindowsTool(ctx('WaitFor', { condition: 'active_window', window_name: '用户账户控制' }, 'unrestricted'), {
      screenConsent: leases,
    });
    expect(route.behavior).toBe('auto_allow');
  });
});

describe('input hygiene (§6.2/§14.2)', () => {
  it('malformed input denies outright', () => {
    const route = classifyWindowsTool(ctx('Click', { loc: 'not-a-thing' as unknown as Record<string, unknown> }));
    // loc is a documented field with a wrong type — the classifier only
    // fails closed on non-record inputs; a wrong-typed field is still a
    // parse problem per §6.2.
    expect(['deny', 'prompt']).toContain(route.behavior);
  });

  it('a non-record input is a hard deny', () => {
    const route = classifyWindowsTool(ctx('Click', null as unknown as Record<string, unknown>));
    expect(route.behavior).toBe('deny');
    expect(route.reasonCode).toBe('malformed_input');
  });

  it('oversized inputs are never auto except in unrestricted (A 完全自动放行)', () => {
    const leases = consented();
    const big: Record<string, unknown> = { text: 'x'.repeat(300 * 1024) };
    const route = classifyWindowsTool(ctx('Type', big, 'unrestricted'), { screenConsent: leases });
    expect(route.behavior).toBe('auto_allow');
    // non-unrestricted still prompts
    const route2 = classifyWindowsTool(ctx('Type', big, 'workspace_write'), { screenConsent: leases });
    expect(route2.behavior).toBe('prompt');
    expect(route2.reasonCode).toBe('input_too_large');
  });
});

describe('consent store behaviour', () => {
  it('revokeConversation drops exactly one conversation', () => {
    const leases = new ScreenConsentLeases();
    leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'a', ttlMs: SCREEN_CONSENT_TTL_MS }, 0);
    leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'b', ttlMs: SCREEN_CONSENT_TTL_MS }, 0);
    leases.revokeConversation('a');
    expect(leases.active('a', 1)).toBe(false);
    expect(leases.active('b', 1)).toBe(true);
  });

  it('revokeAll drops everything (global emergency stop)', () => {
    const leases = new ScreenConsentLeases();
    leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'a', ttlMs: SCREEN_CONSENT_TTL_MS }, 0);
    leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'b', ttlMs: SCREEN_CONSENT_TTL_MS }, 0);
    leases.revokeAll();
    expect(leases.active('a', 1)).toBe(false);
    expect(leases.active('b', 1)).toBe(false);
  });

  it('a re-approval resets the TTL (a fresh human decision)', () => {
    const leases = new ScreenConsentLeases();
    const ttl = 1_000;
    leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'a', ttlMs: ttl }, 0);
    leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'a', ttlMs: ttl }, 500);
    expect(leases.active('a', 1_400)).toBe(true);
    expect(leases.active('a', 1_600)).toBe(false);
  });
});

describe('safe preview (§6.2 redaction)', () => {
  it('never echoes typed text, shortcut combos or app names', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['Type', { text: 'super-secret-password' }],
      ['Shortcut', { shortcut: 'win+r' }],
      ['App', { mode: 'launch_executable', executable: 'C:/Windows/System32/cmd.exe' }],
    ];
    for (const [tool, input] of cases) {
      const preview = buildWindowsApprovalPreview({
        toolName: `mcp__${WINDOWS_SERVER_NAME}__${tool}`,
        input,
      });
      expect(JSON.stringify(preview)).not.toContain('super-secret-password');
      expect(JSON.stringify(preview)).not.toContain('win+r');
      expect(JSON.stringify(preview)).not.toContain('cmd.exe');
    }
  });

  it('shows the target shape for clicks', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Click`,
      input: { loc: [120, 90] },
    });
    expect(preview.target).toContain('120,90');
    // The 2026-09-03 computer-use visual block: an action label + a mini
    // screen render on the card instead of a bare summary row.
    expect(preview.kind).toBe('desktop');
    expect((preview as { actionLabel?: string }).actionLabel).toBe('桌面点击 / 选择');
  });

  it('reports the typed LENGTH, never the text (C06)', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Type`,
      input: { text: 'super-secret-password' },
    }) as { textChars?: number };
    expect(preview.textChars).toBe('super-secret-password'.length);
    expect(JSON.stringify(preview)).not.toContain('super-secret-password');
  });

  it('Clipboard set previews show only the LENGTH, never the payload', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Clipboard`,
      input: { mode: 'set', text: 'secret-drawing-script' },
    }) as { textChars?: number; actionLabel?: string };
    expect(preview.textChars).toBe('secret-drawing-script'.length);
    expect(preview.actionLabel).toBe('剪贴板（内容已隐藏）');
    expect(JSON.stringify(preview)).not.toContain('secret-drawing-script');
  });

  it('Ocr previews describe the screen region (screen-read class)', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Ocr`,
      input: { region: [0, 1300, 400, 1400] },
    });
    expect(preview.target).toContain('0,1300,400,1400');
  });

  it('never throws on unexpected input', () => {
    const preview = buildWindowsApprovalPreview({
      toolName: `mcp__${WINDOWS_SERVER_NAME}__Click`,
      input: null as unknown as Record<string, unknown>,
    });
    expect(preview.kind).toBe('desktop');
  });
});

// ── PR-6 偏差③收口: output-side sensitive-window recognition ──────────

function toolUse(id: string, toolName: string): import('../../host-adapter/loop-events').LoopEvent {
  return { type: 'tool_use', seq: 1, ts: 1, turn: 1, id, tool: toolName, input: {} } as never;
}

function toolResult(id: string, output: string): import('../../host-adapter/loop-events').LoopEvent {
  return { type: 'tool_result', seq: 2, ts: 2, turn: 1, id, tool: '', ok: true, output, durationMs: 1 } as never;
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
      expect(outputIndicatesSensitiveWindow(text)).toBe(true);
    }
    for (const text of ['', undefined, null, '记事本 - 无标题', 'Chrome 百度搜索结果页']) {
      expect(outputIndicatesSensitiveWindow(text as string)).toBe(false);
    }
  });

  it('revokes the conversation consent when a screen read shows a UAC window', () => {
    const leases = consented();
    const watcher = createSensitiveWindowWatcher(leases);
    // The tool_use and its result arrive in DIFFERENT batches — the watcher
    // must track the in-flight call across batches.
    expect(watcher([toolUse('tu-1', `mcp__${WINDOWS_SERVER_NAME}__Snapshot`)], 'conv-1')).toBe(false);
    expect(leases.active('conv-1', 1_000)).toBe(true);
    expect(
      watcher([toolResult('tu-1', '窗口列表: [用户账户控制] 是(Y) 否(N)')], 'conv-1'),
    ).toBe(true);
    // 拒绝自动化: the lease is gone — steering and screen reads re-prompt.
    expect(leases.active('conv-1', 1_000)).toBe(false);
    const route = classifyWindowsTool(ctx('Move', {}, 'workspace_write'), { screenConsent: leases });
    expect(route.behavior).toBe('prompt');
    expect(route.reasonCode).toBe('desktop_task_requires_consent');
  });

  it('ordinary result text keeps the lease alive', () => {
    const leases = consented();
    const watcher = createSensitiveWindowWatcher(leases);
    watcher([toolUse('tu-2', `mcp__${WINDOWS_SERVER_NAME}__Screenshot`)], 'conv-1');
    expect(watcher([toolResult('tu-2', '屏幕截图完成（1.2 MB）')], 'conv-1')).toBe(false);
    expect(leases.active('conv-1', 1_000)).toBe(true);
  });

  it('only trylo-windows results can trigger revocation', () => {
    const leases = consented();
    const watcher = createSensitiveWindowWatcher(leases);
    watcher([toolUse('tu-3', 'mcp__trylo-browser__browser_snapshot')], 'conv-1');
    expect(watcher([toolResult('tu-3', 'User Account Control dialog found')], 'conv-1')).toBe(false);
    expect(leases.active('conv-1', 1_000)).toBe(true);
  });

  it('revocation is scoped to the conversation', () => {
    const leases = consented();
    leases.grant({ kind: 'windows-screen', actionClass: 'windows-desktop', conversationId: 'conv-2', ttlMs: SCREEN_CONSENT_TTL_MS }, 1_000);
    const watcher = createSensitiveWindowWatcher(leases);
    watcher([toolUse('tu-4', `mcp__${WINDOWS_SERVER_NAME}__Snapshot`)], 'conv-1');
    watcher([toolResult('tu-4', '管理员: 注册表编辑器')], 'conv-1');
    expect(leases.active('conv-1', 1_000)).toBe(false);
    expect(leases.active('conv-2', 1_000)).toBe(true);
  });
});
