// Trylo Desktop — Playwright risk classifier tests.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.5 (action table) ×
// §6.3 (permission matrix) / §6.2 (URL rules, annotations-are-hints) /
// §14.2 (data-driven matrix requirements). PR-3 acceptance (§13):
// 查、填、抓、下载题集；提交/发送/上传必须审批.

import { describe, expect, it } from 'vitest';

import {
  BROWSER_LEASE_TTL_MS,
  BrowserOriginLeases,
  PLAYWRIGHT_EXPECTED_TOOLS,
  PLAYWRIGHT_SERVER_NAME,
  PLAYWRIGHT_TOOL_NAMES,
  buildPlaywrightApprovalPreview,
  classifyPlaywrightTool,
  parseBrowserOrigin,
} from './playwright-classifier';
import type { ToolRiskContext } from '../tool-risk-classifier';
import type { PermissionLevel } from '../../permission/permission-policy';

const ROOT = 'D:/work/proj';
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
  at = 1_700_000_000_000,
): ToolRiskContext {
  return {
    profileId: 'work.core.v1',
    packageId: 'playwright',
    toolName: `mcp__${PLAYWRIGHT_SERVER_NAME}__${tool}`,
    input,
    permissionLevel: level,
    projectRoot: ROOT,
    conversationId: 'conv-1',
    at,
  };
}

describe('pinned surface', () => {
  it('PLAYWRIGHT_EXPECTED_TOOLS covers exactly the pinned 24 tools', () => {
    expect(PLAYWRIGHT_TOOL_NAMES).toHaveLength(24);
    expect(PLAYWRIGHT_EXPECTED_TOOLS).toHaveLength(24);
    expect(new Set(PLAYWRIGHT_EXPECTED_TOOLS).size).toBe(24);
    for (const full of PLAYWRIGHT_EXPECTED_TOOLS) {
      expect(full.startsWith(`mcp__${PLAYWRIGHT_SERVER_NAME}__`)).toBe(true);
    }
  });

  it('a tool NOT in the pinned set is denied (drift = upgrade event, §3)', () => {
    for (const level of ALL_LEVELS) {
      const decision = classifyPlaywrightTool(
        ctx('browser_instagram_post', {}, level),
      );
      expect(decision.behavior).toBe('deny');
      if (decision.behavior === 'deny') expect(decision.reasonCode).toBe('unknown_tool');
    }
  });
});

describe('read tools auto-allow at every level (§6.5 snapshot/console/network 读取)', () => {
  const readCases: readonly [string, Record<string, unknown>][] = [
    ['browser_snapshot', {}],
    ['browser_console_messages', { level: 'info' }],
    ['browser_network_requests', { static: false }],
    ['browser_network_request', { index: 3 }],
    ['browser_find', { text: 'error' }],
    ['browser_wait_for', { time: 2 }],
    ['browser_take_screenshot', { scale: 'css' }],
    ['browser_hover', { element: 'header logo', target: 'img' }],
    ['browser_resize', { width: 1280, height: 720 }],
    ['browser_close', {}],
    ['browser_navigate_back', {}],
  ];

  for (const [tool, input] of readCases) {
    it(`${tool} is automatic at every level (server annotations are NOT consulted)`, () => {
      for (const level of ALL_LEVELS) {
        const decision = classifyPlaywrightTool(ctx(tool, input, level));
        expect(decision.behavior).toBe('auto_allow');
        if (decision.behavior === 'auto_allow') {
          expect(decision.risk).toBe('read');
          expect(decision.reasonCode).toBe('browser_read');
        }
      }
    });
  }

  it('an explicit filename WRITES the workspace root (verified pinned-server behaviour), not the output dir', () => {
    // read_only: deny (a workspace write is unavailable).
    expect(classifyPlaywrightTool(ctx('browser_take_screenshot', { scale: 'css', filename: 'page.png' }, 'read_only')).behavior).toBe('deny');
    // ask/workspace_write: approval.
    for (const level of ['ask', 'workspace_write'] as const) {
      const decision = classifyPlaywrightTool(ctx('browser_take_screenshot', { scale: 'css', filename: 'page.png' }, level));
      expect(decision.behavior).toBe('prompt');
      expect(decision.behavior === 'prompt' && decision.reasonCode).toBe('filename_writes_workspace');
    }
    // unrestricted: auto, as a workspace-write.
    const auto = classifyPlaywrightTool(ctx('browser_take_screenshot', { scale: 'css', filename: 'page.png' }, 'unrestricted'));
    expect(auto.behavior).toBe('auto_allow');
    expect(auto.behavior === 'auto_allow' && auto.risk).toBe('workspace-write');
    // evaluate with a filename is STILL bypass-immune (code tool).
    const evaluate = classifyPlaywrightTool(ctx('browser_evaluate', { function: '() => 1', filename: 'out.json' }, 'unrestricted'));
    expect(evaluate.behavior).toBe('prompt');
    expect(evaluate.behavior === 'prompt' && evaluate.reasonCode).toBe('evaluate_requires_approval');
  });

  it('screenshot filenames may stay relative but never escape the runtime dir', () => {
    for (const bad of ['../escape.png', 'C:/temp/x.png', '\\\\server\\share\\x.png']) {
      const decision = classifyPlaywrightTool(ctx('browser_take_screenshot', { scale: 'css', filename: bad }));
      expect(decision.behavior).toBe('deny');
    }
  });
});

describe('navigate × permission level (§6.5: 首次访问新域审批，域内读取可短期授权)', () => {
  it('workspace_write: first visit to an origin is a prompt carrying a lease proposal', () => {
    const decision = classifyPlaywrightTool(ctx('browser_navigate', { url: 'https://docs.example.com/guide?token=x' }));
    expect(decision.behavior).toBe('prompt');
    if (decision.behavior === 'prompt') {
      expect(decision.risk).toBe('external');
      expect(decision.reasonCode).toBe('navigate_new_origin');
      expect(decision.lease).toEqual({
        kind: 'browser-origin',
        origin: 'https://docs.example.com',
        actionClass: 'navigate',
        conversationId: 'conv-1',
        ttlMs: BROWSER_LEASE_TTL_MS,
      });
      // The preview shows origin+path, never query strings (tokens!).
      expect(decision.preview.target).not.toContain('token');
    }
  });

  it('a lease grant unlocks in-origin navigation until expiry (5 min TTL)', () => {
    const leases = new BrowserOriginLeases();
    leases.grant({ kind: 'browser-origin', origin: 'https://docs.example.com', actionClass: 'navigate', conversationId: 'conv-1', ttlMs: BROWSER_LEASE_TTL_MS }, 1_000);
    const inside = classifyPlaywrightTool(
      ctx('browser_navigate', { url: 'https://docs.example.com/other' }, 'workspace_write', 60_000),
      { leases },
    );
    expect(inside.behavior).toBe('auto_allow');
    // A DIFFERENT origin is still a prompt.
    const other = classifyPlaywrightTool(
      ctx('browser_navigate', { url: 'https://evil.example.com/' }, 'workspace_write', 60_000),
      { leases },
    );
    expect(other.behavior).toBe('prompt');
    // After TTL expiry the same origin prompts again.
    const expired = classifyPlaywrightTool(
      ctx('browser_navigate', { url: 'https://docs.example.com/other' }, 'workspace_write', 1_000 + BROWSER_LEASE_TTL_MS + 1),
      { leases },
    );
    expect(expired.behavior).toBe('prompt');
  });

  it('leases are conversation-scoped', () => {
    const leases = new BrowserOriginLeases();
    leases.grant({ kind: 'browser-origin', origin: 'https://a.com', actionClass: 'navigate', conversationId: 'conv-1', ttlMs: BROWSER_LEASE_TTL_MS }, 0);
    expect(leases.active('https://a.com', 'conv-2', 1)).toBe(false);
    expect(leases.active('https://a.com', 'conv-1', 1)).toBe(true);
  });

  it('unrestricted auto-allows navigation (§6.3: 普通操作可自动)', () => {
    const decision = classifyPlaywrightTool(ctx('browser_navigate', { url: 'https://example.com/' }, 'unrestricted'));
    expect(decision.behavior).toBe('auto_allow');
  });

  it('read_only and ask levels always approve navigation (never auto)', () => {
    for (const level of ['read_only', 'ask'] as const) {
      const decision = classifyPlaywrightTool(ctx('browser_navigate', { url: 'https://example.com/' }, level));
      expect(decision.behavior).toBe('prompt');
    }
  });

  it('URL policy (§6.2: standard protocols only, no prefix games)', () => {
    for (const bad of ['javascript:alert(1)', 'file:///C:/secrets.md', 'data:text/html,x', 'not a url', '']) {
      const decision = classifyPlaywrightTool(ctx('browser_navigate', { url: bad }));
      expect(decision.behavior).toBe('deny');
      if (decision.behavior === 'deny') expect(decision.reasonCode).toBe('invalid_url');
    }
    const creds = classifyPlaywrightTool(ctx('browser_navigate', { url: 'https://user:pass@example.com/' }));
    expect(creds.behavior).toBe('deny');
    expect(creds.behavior === 'deny' && creds.reasonCode).toBe('url_with_credentials');
  });

  it('parseBrowserOrigin normalizes to scheme://host[:port] and drops paths', () => {
    expect(parseBrowserOrigin('https://a.example.com/x/y?z=1')).toEqual({ kind: 'ok', origin: 'https://a.example.com' });
    expect(parseBrowserOrigin('http://localhost:3000/')).toEqual({ kind: 'ok', origin: 'http://localhost:3000' });
    expect(parseBrowserOrigin('ftp://x.com/').kind).toBe('invalid');
  });

  it('manifest blocked origins deny outright; a non-empty allow list makes outside-origins prompt', () => {
    const blocked = classifyPlaywrightTool(
      ctx('browser_navigate', { url: 'https://tracker.example.com/' }),
      { blockedOrigins: ['https://tracker.example.com'] },
    );
    expect(blocked.behavior).toBe('deny');
    expect(blocked.behavior === 'deny' && blocked.reasonCode).toBe('origin_blocked');

    const outside = classifyPlaywrightTool(
      ctx('browser_navigate', { url: 'https://outside.example.com/' }, 'workspace_write'),
      { allowedOrigins: ['https://inside.example.com'] },
    );
    expect(outside.behavior).toBe('prompt');
    // A 完全自动下 outside 也放行
    expect(
      classifyPlaywrightTool(ctx('browser_navigate', { url: 'https://outside.example.com/' }, 'unrestricted'), {
        allowedOrigins: ['https://inside.example.com'],
      }).behavior,
    ).toBe('auto_allow');
  });

  it('tabs: list/select are reads, a blank new tab is automatic, close is a prompt except in unrestricted', () => {
    for (const level of ['read_only', 'ask', 'workspace_write'] as const) {
      expect(classifyPlaywrightTool(ctx('browser_tabs', { action: 'list' }, level)).behavior).toBe('auto_allow');
      expect(classifyPlaywrightTool(ctx('browser_tabs', { action: 'select', index: 0 }, level)).behavior).toBe('auto_allow');
      expect(classifyPlaywrightTool(ctx('browser_tabs', { action: 'new' }, level)).behavior).toBe('auto_allow');
      expect(classifyPlaywrightTool(ctx('browser_tabs', { action: 'close' }, level)).behavior).toBe('prompt');
    }
    for (const level of ['unrestricted'] as const) {
      expect(classifyPlaywrightTool(ctx('browser_tabs', { action: 'close' }, level)).behavior).toBe('auto_allow');
    }
    const tabNav = classifyPlaywrightTool(ctx('browser_tabs', { action: 'new', url: 'https://example.com/' }));
    expect(tabNav.behavior).toBe('prompt');
    expect(tabNav.behavior === 'prompt' && tabNav.reasonCode).toBe('navigate_new_origin');
  });
});

describe('interaction tools (§6.5: click/fill/type/select/drag/dialog/upload = ask)', () => {
  const interactionCases: readonly [string, Record<string, unknown>][] = [
    ['browser_click', { element: 'Save button', target: 'button#save' }],
    ['browser_type', { element: 'search box', target: 'input#q', text: 'hello' }],
    ['browser_press_key', { key: 'Enter' }],
    ['browser_fill_form', { fields: [{ target: 'input#name', name: 'Name', type: 'textbox', value: 'Ada' }] }],
    ['browser_select_option', { target: 'select#size', values: ['L'] }],
    ['browser_drag', { startTarget: 'a', endTarget: 'b' }],
    ['browser_drop', { target: 'div#zone' }],
    ['browser_file_upload', {}],
    ['browser_handle_dialog', { accept: true }],
  ];

  it('every interaction is an approval at ask/workspace_write (§6.3 审批)', () => {
    for (const [tool, input] of interactionCases) {
      for (const level of ['ask', 'workspace_write'] as const) {
        const decision = classifyPlaywrightTool(ctx(tool, input, level));
        expect(decision.behavior).toBe('prompt');
        if (decision.behavior === 'prompt') {
          expect(['external', 'sensitive']).toContain(decision.risk);
          expect(decision.reasonCode).not.toBe('unknown_tool');
        }
      }
    }
  });

  it('every interaction is DENIED at read_only (§6.3: 点击/输入拒绝)', () => {
    for (const [tool, input] of interactionCases) {
      const decision = classifyPlaywrightTool(ctx(tool, input, 'read_only'));
      expect(decision.behavior).toBe('deny');
      if (decision.behavior === 'deny') expect(decision.reasonCode).toBe('interaction_denied_read_only');
    }
  });

  it('sensitive target semantics escalate to sensitive prompts — A 完全自动下 unrestricted 放行', () => {
    const words = ['Submit order', 'Send message', 'Publish post', 'Delete file', 'Payment', 'Checkout', 'Login form', 'Sign in', 'Grant permission', 'password field'];
    for (const element of words) {
      const decision = classifyPlaywrightTool(ctx('browser_click', { element, target: 'x' }, 'workspace_write'));
      expect(decision.behavior).toBe('prompt');
      if (decision.behavior === 'prompt') {
        expect(decision.risk).toBe('sensitive');
        expect(decision.reasonCode).toBe('sensitive_target');
      }
    }
    // unrestricted 一律放行
    for (const element of words) {
      expect(classifyPlaywrightTool(ctx('browser_click', { element, target: 'x' }, 'unrestricted')).behavior).toBe('auto_allow');
    }
  });

  it('type with submit:true is sensitive except in unrestricted (A 完全自动放行)', () => {
    const decision = classifyPlaywrightTool(
      ctx('browser_type', { target: 'input#q', text: 'hello', submit: true }, 'workspace_write'),
    );
    expect(decision.behavior).toBe('prompt');
    expect(decision.behavior === 'prompt' && decision.reasonCode).toBe('sensitive_target');
    expect(classifyPlaywrightTool(ctx('browser_type', { target: 'input#q', text: 'hello', submit: true }, 'unrestricted')).behavior).toBe('auto_allow');
  });

  it('uploads are approvals and validated like any path (strict reading)', () => {
    const ok = classifyPlaywrightTool(ctx('browser_file_upload', { paths: ['docs/report.pdf'] }));
    expect(ok.behavior).toBe('prompt');
    expect(ok.behavior === 'prompt' && ok.reasonCode).toBe('uploads_local_file');

    for (const bad of [['../escape.pdf'], ['D:/tmp/x.pdf'], ['\\\\srv\\share\\x'], ['CON.pdf'], ['docs/..//x']]) {
      const decision = classifyPlaywrightTool(ctx('browser_file_upload', { paths: bad }, 'unrestricted'));
      expect(decision.behavior).toBe('deny');
    }
  });
});

describe('code tools (§6.5: JavaScript evaluate = sensitive, 始终审批)', () => {
  for (const tool of ['browser_evaluate', 'browser_run_code_unsafe']) {
    it(`${tool} is denied read_only and approved at every other level`, () => {
      expect(classifyPlaywrightTool(ctx(tool, { function: '() => 1' }, 'read_only')).behavior).toBe('deny');
      for (const level of ['ask', 'workspace_write', 'unrestricted'] as const) {
        const decision = classifyPlaywrightTool(ctx(tool, { function: '() => 1' }, level));
        expect(decision.behavior).toBe('prompt');
        if (decision.behavior === 'prompt') {
          expect(decision.risk).toBe('sensitive');
          expect(decision.reasonCode).toBe('evaluate_requires_approval');
        }
      }
    });
  }
});

describe('input hardening (§14.2: 未知值、缺字段、类型错误、超大 input)', () => {
  it('malformed input is denied, never guessed', () => {
    expect(classifyPlaywrightTool(ctx('browser_navigate', { url: 42 })).behavior).toBe('deny');
    expect(classifyPlaywrightTool(ctx('browser_tabs', { action: 'detonate' })).behavior).toBe('deny');
    expect(classifyPlaywrightTool(ctx('browser_take_screenshot', { filename: 7 })).behavior).toBe('deny');
    expect(classifyPlaywrightTool(ctx('browser_file_upload', { paths: 'docs/a.pdf' })).behavior).toBe('deny');
    expect(
      classifyPlaywrightTool(ctx('browser_click', 'not-an-object' as unknown as Record<string, unknown>)).behavior,
    ).toBe('deny');
  });

  it('oversized input is never auto except in unrestricted (A 完全自动放行)', () => {
    const big = { element: 'x'.repeat(300 * 1024), target: 'a' };
    const decision = classifyPlaywrightTool(ctx('browser_hover', big, 'unrestricted'));
    expect(decision.behavior).toBe('auto_allow');
    const decision2 = classifyPlaywrightTool(ctx('browser_hover', big, 'workspace_write'));
    expect(decision2.behavior).toBe('prompt');
    if (decision2.behavior === 'prompt') expect(decision2.reasonCode).toBe('input_too_large');
  });
});

describe('safe preview (§6.2: 不展示键入文本/表单值/脚本)', () => {
  it('navigate preview shows origin+path but strips the query string', () => {
    const preview = buildPlaywrightApprovalPreview(
      ctx('browser_navigate', { url: 'https://shop.example.com/cart?session=SECRET#pay' }),
      '需审批',
    );
    expect(preview.kind).toBe('summary');
    expect(preview.target).toContain('https://shop.example.com/cart');
    expect(JSON.stringify(preview)).not.toContain('SECRET');
  });

  it('type/evaluate/dialog previews never echo the typed text, code or prompt text', () => {
    const typed = buildPlaywrightApprovalPreview(
      ctx('browser_type', { element: 'comment box', target: 'textarea', text: 'TOPSECRET-CONTENT' }),
    );
    expect(JSON.stringify(typed)).not.toContain('TOPSECRET-CONTENT');
    expect(typed.target).toBe('comment box');

    const code = buildPlaywrightApprovalPreview(ctx('browser_evaluate', { function: '() => fetch("http://evil")' }));
    expect(JSON.stringify(code)).not.toContain('fetch');

    const dialog = buildPlaywrightApprovalPreview(ctx('browser_handle_dialog', { accept: true, promptText: 'SECRET-ANSWER' }));
    expect(JSON.stringify(dialog)).not.toContain('SECRET-ANSWER');
  });

  it('upload previews show basenames only, capped at 3 + count', () => {
    const preview = buildPlaywrightApprovalPreview(
      ctx('browser_file_upload', { paths: ['docs/a.pdf', 'docs/b.pdf', 'docs/c.pdf', 'docs/d.pdf'] }),
    );
    expect(preview.target).toContain('a.pdf');
    expect(preview.target).toContain('4 个文件');
    expect(preview.target).not.toContain('docs/');
  });
});
