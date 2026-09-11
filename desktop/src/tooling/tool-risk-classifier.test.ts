// Trylo Desktop — Tool risk classifier router tests (spec §6.2).
//
// Pins the ROUTING contract:
//   - non-MCP tools and foreign MCP servers are `unmanaged` (default
//     human-approval path, never auto-decided by the host);
//   - a managed server with an unexpected tool name is DENIED (tools/list
//     drift is an upgrade event, §3);
//   - a managed package the run's Profile did not activate stays unmanaged
//     (§4.3 explicit composition has teeth on the host side too);
//   - the registered classifier matches the shipped desktop-services
//     manifest (classifierId / serverName / expectedTools) — the two
//     packages are separate, so this cross-import is the drift alarm.

import { describe, expect, it } from 'vitest';

import {
  createToolRiskClassifier,
  inputDigestOf,
  parseMcpToolName,
} from './tool-risk-classifier';
import { OFFICECLI_TOOL_NAME } from './classifiers/officecli-classifier';
import {
  PLAYWRIGHT_EXPECTED_TOOLS,
  PLAYWRIGHT_SERVER_NAME,
} from './classifiers/playwright-classifier';
import {
  WINDOWS_EXPECTED_TOOLS,
  WINDOWS_SERVER_NAME,
} from './classifiers/windows-mcp-classifier';
import {
  CHROME_DEVTOOLS_EXPECTED_TOOLS,
  CHROME_DEVTOOLS_SERVER_NAME,
} from './classifiers/chrome-devtools-classifier';
import { OFFICECLI_MANIFEST } from '../../../desktop-services/src/tooling/manifests/officecli.mjs';
import { PLAYWRIGHT_MANIFEST } from '../../../desktop-services/src/tooling/manifests/playwright.mjs';
import { WINDOWS_MCP_MANIFEST } from '../../../desktop-services/src/tooling/manifests/windows-mcp.mjs';
import { CHROME_DEVTOOLS_MANIFEST } from '../../../desktop-services/src/tooling/manifests/chrome-devtools.mjs';

function request(overrides: Partial<Parameters<ReturnType<typeof createToolRiskClassifier>['classify']>[0]> = {}) {
  return {
    toolName: OFFICECLI_TOOL_NAME,
    input: { command: 'view', file: 'docs/a.docx' },
    permissionLevel: 'workspace_write' as const,
    projectRoot: 'D:/work/proj',
    conversationId: 'conv-1',
    profileId: 'work.core.v1',
    managedPackageIds: ['officecli'],
    ...overrides,
  };
}

describe('parseMcpToolName', () => {
  it('splits the mcp__server__tool form, underscores included', () => {
    expect(parseMcpToolName('mcp__trylo-office__officecli')).toEqual({
      serverName: 'trylo-office',
      toolName: 'officecli',
    });
    expect(parseMcpToolName('mcp__srv__tool_with_underscores')).toEqual({
      serverName: 'srv',
      toolName: 'tool_with_underscores',
    });
  });

  it('returns null for built-ins and malformed names', () => {
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName('mcp__no_tool')).toBeNull();
    expect(parseMcpToolName('mcp__')).toBeNull();
    expect(parseMcpToolName('mcp')).toBeNull();
    expect(parseMcpToolName('')).toBeNull();
  });
});

describe('routing (§6.2)', () => {
  it('built-in tools are unmanaged — the default approval path applies', () => {
    const router = createToolRiskClassifier();
    for (const toolName of ['Bash', 'Write', 'Edit', 'WebFetch']) {
      expect(router.classify(request({ toolName, input: { command: 'ls' } }))).toEqual({
        behavior: 'unmanaged',
      });
    }
  });

  it('foreign MCP servers are unmanaged (the user\u2019s own MCP stays human-approved)', () => {
    const router = createToolRiskClassifier();
    expect(
      router.classify(request({ toolName: 'mcp__trylo-hermes-capabilities__search' })),
    ).toEqual({ behavior: 'unmanaged' });
    expect(router.classify(request({ toolName: 'mcp__someone-elses-server__tool' }))).toEqual({
      behavior: 'unmanaged',
    });
  });

  it('an unexpected tool on a MANAGED server is denied (§3 drift = upgrade event)', () => {
    const router = createToolRiskClassifier();
    const route = router.classify(request({ toolName: 'mcp__trylo-office__surprise_tool' }));
    expect(route.behavior).toBe('deny');
    if (route.behavior === 'deny') {
      expect(route.reasonCode).toBe('unknown_tool');
      expect(route.userMessage).toContain('trylo-office');
    }
  });

  it('routes the managed tool to its classifier with the packageId filled', () => {
    const router = createToolRiskClassifier();
    const route = router.classify(request());
    expect(route.behavior).toBe('auto_allow');
    if (route.behavior === 'auto_allow') {
      expect(route.audit.packageId).toBe('officecli');
      expect(route.audit.profileId).toBe('work.core.v1');
    }
  });

  it('a managed package the Profile did NOT activate stays unmanaged (§4.3)', () => {
    const router = createToolRiskClassifier();
    expect(router.classify(request({ managedPackageIds: [] }))).toEqual({ behavior: 'unmanaged' });
    expect(
      router.classify(request({ managedPackageIds: ['playwright', 'windows-mcp'] })),
    ).toEqual({ behavior: 'unmanaged' });
  });

  it('without the list (undefined) the classifier still applies — legacy runs are rare but real', () => {
    const router = createToolRiskClassifier();
    const { managedPackageIds: _omitted, ...withoutList } = request();
    expect(router.classify(withoutList).behavior).toBe('auto_allow');
  });

  it('exposes the managed server names for diagnostics (core four + the CAD/EDA adapters)', () => {
    const router = createToolRiskClassifier();
    expect(router.serverNames()).toEqual([
      'trylo-office',
      'trylo-browser',
      'trylo-windows',
      'trylo-chrome',
      'trylo-solidworks',
      'trylo-autocad',
      'trylo-kicad',
      'trylo-jlceda',
      'trylo-freecad',
      'trylo-blender',
    ]);
  });
});

describe('cross-package contract with the shipped manifest', () => {
  it('the officecli classifier matches OFFICECLI_MANIFEST exactly', () => {
    // TS import of a .mjs value — typed via the manifest's shape.
    const manifest = OFFICECLI_MANIFEST as unknown as {
      id: string;
      classifierId: string;
      mcp: { serverName: string; expectedTools: readonly string[] };
    };
    const router = createToolRiskClassifier();
    expect(router.serverNames()).toContain(manifest.mcp.serverName);
    expect(OFFICECLI_TOOL_NAME).toBe(
      `mcp__${manifest.mcp.serverName}__${manifest.mcp.expectedTools[0]}`,
    );
    // A new expectedTools entry in the manifest MUST come with a classifier
    // update — this assertion is what forces the two to move together (§3).
    expect(manifest.mcp.expectedTools).toEqual(['officecli']);
    expect(manifest.classifierId).toBe('officecli');
  });

  it('the playwright classifier matches PLAYWRIGHT_MANIFEST exactly (PR-3)', () => {
    const manifest = PLAYWRIGHT_MANIFEST as unknown as {
      id: string;
      classifierId: string;
      mcp: { serverName: string; expectedTools: readonly string[] };
    };
    const router = createToolRiskClassifier();
    expect(router.serverNames()).toContain(manifest.mcp.serverName);
    expect(PLAYWRIGHT_SERVER_NAME).toBe(manifest.mcp.serverName);
    // EXACT set (§3): same members, same size — order is presentation.
    expect([...PLAYWRIGHT_EXPECTED_TOOLS].sort()).toEqual(
      manifest.mcp.expectedTools.map((t) => `mcp__${manifest.mcp.serverName}__${t}`).sort(),
    );
    // The pinned 0.0.79 surface: exactly 24 tools (no --caps flag exists).
    expect(manifest.mcp.expectedTools).toHaveLength(24);
    expect(manifest.classifierId).toBe('playwright');
    expect(manifest.id).toBe('playwright');
  });

  it('every pinned playwright tool is handled by the classifier (no unknown_tool on the pinned surface)', () => {
    const router = createToolRiskClassifier();
    for (const full of PLAYWRIGHT_EXPECTED_TOOLS) {
      const short = full.split('__').pop() ?? full;
      const input =
        short === 'browser_navigate' ? { url: 'https://example.com/' }
        : short === 'browser_tabs' ? { action: 'list' }
        : {};
      const route = router.classify(request({
        toolName: full,
        input,
        managedPackageIds: ['officecli', 'playwright'],
      }));
      if (route.behavior === 'deny') {
        throw new Error(`${full} routed to deny: ${route.reasonCode}`);
      }
      expect(['unmanaged', 'auto_allow', 'prompt']).toContain(route.behavior);
    }
  });

  it('the windows classifier matches WINDOWS_MCP_MANIFEST exactly (PR-6)', () => {
    const manifest = WINDOWS_MCP_MANIFEST as unknown as {
      id: string;
      classifierId: string;
      mcp: { serverName: string; expectedTools: readonly string[] };
    };
    const router = createToolRiskClassifier();
    expect(router.serverNames()).toContain(manifest.mcp.serverName);
    expect(WINDOWS_SERVER_NAME).toBe(manifest.mcp.serverName);
    // EXACT set (§3): same members, same size — order is presentation.
    expect([...WINDOWS_EXPECTED_TOOLS].sort()).toEqual(
      manifest.mcp.expectedTools.map((t) => `mcp__${manifest.mcp.serverName}__${t}`).sort(),
    );
    // §6.6: exactly the 14 allowed tools (12 upstream + Clipboard + Ocr).
    expect(manifest.mcp.expectedTools).toHaveLength(14);
    expect(manifest.classifierId).toBe('windows-mcp');
    expect(manifest.id).toBe('windows-mcp');
  });

  it('every pinned windows tool is handled by the classifier (no unknown_tool on the pinned surface)', () => {
    const router = createToolRiskClassifier();
    for (const full of WINDOWS_EXPECTED_TOOLS) {
      const route = router.classify(request({
        toolName: full,
        input: {},
        managedPackageIds: ['officecli', 'playwright', 'windows-mcp'],
      }));
      if (route.behavior === 'deny') {
        throw new Error(`${full} routed to deny: ${route.reasonCode}`);
      }
      expect(['unmanaged', 'auto_allow', 'prompt']).toContain(route.behavior);
    }
  });

  it('the 7 excluded windows tools are unknown_tool even with the package managed (§6.6)', () => {
    const router = createToolRiskClassifier();
    for (const denied of ['PowerShell', 'FileSystem', 'Scrape', 'Process', 'Registry', 'MultiEdit', 'Notification']) {
      const route = router.classify(request({
        toolName: `mcp__trylo-windows__${denied}`,
        input: {},
        managedPackageIds: ['officecli', 'playwright', 'windows-mcp'],
      }));
      // The server allowlist can never emit these, so the router treats
      // them as drift — unknown_tool, NOT an approval path. unrestricted
      // cannot re-enable what the server argv removed (§6.6).
      expect(route).toMatchObject({ behavior: 'deny', reasonCode: 'unknown_tool' });
    }
  });

  it('the chrome-devtools classifier matches CHROME_DEVTOOLS_MANIFEST exactly (PR-7)', () => {
    const manifest = CHROME_DEVTOOLS_MANIFEST as unknown as {
      id: string;
      classifierId: string;
      mcp: { serverName: string; expectedTools: readonly string[] };
    };
    const router = createToolRiskClassifier();
    expect(router.serverNames()).toContain(manifest.mcp.serverName);
    expect(CHROME_DEVTOOLS_SERVER_NAME).toBe(manifest.mcp.serverName);
    // EXACT set (§3): same members, same size — order is presentation.
    expect([...CHROME_DEVTOOLS_EXPECTED_TOOLS].sort()).toEqual(
      manifest.mcp.expectedTools.map((t) => `mcp__${manifest.mcp.serverName}__${t}`).sort(),
    );
    // The pinned 1.8.0 surface: exactly 29 tools (bundled closure).
    expect(manifest.mcp.expectedTools).toHaveLength(29);
    expect(manifest.classifierId).toBe('chrome-devtools');
    expect(manifest.id).toBe('chrome-devtools');
  });

  it('every pinned chrome-devtools tool is handled by the classifier (no unknown_tool on the pinned surface)', () => {
    const router = createToolRiskClassifier();
    for (const full of CHROME_DEVTOOLS_EXPECTED_TOOLS) {
      const route = router.classify(request({
        toolName: full,
        input: {},
        managedPackageIds: ['officecli', 'playwright', 'windows-mcp', 'chrome-devtools'],
      }));
      if (route.behavior === 'deny') {
        throw new Error(`${full} routed to deny: ${route.reasonCode}`);
      }
      expect(['unmanaged', 'auto_allow', 'prompt']).toContain(route.behavior);
    }
  });

  it('a managed chrome-devtools tool outside the Profile is unmanaged (§4.3)', () => {
    const router = createToolRiskClassifier();
    const route = router.classify(request({
      toolName: 'mcp__trylo-chrome__evaluate_script',
      input: { expression: '1' },
      managedPackageIds: ['officecli'],
    }));
    // Not host-decided, not denied: the default human-approval path.
    expect(route).toEqual({ behavior: 'unmanaged' });
  });
});

describe('digest helper', () => {
  it('digests are stable and key-order independent', () => {
    expect(inputDigestOf({ a: 1, b: 2 })).toBe(inputDigestOf({ b: 2, a: 1 }));
    expect(inputDigestOf({ a: 1 })).not.toBe(inputDigestOf({ a: 2 }));
  });
});
