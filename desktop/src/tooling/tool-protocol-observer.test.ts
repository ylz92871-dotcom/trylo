// Trylo Desktop — tool protocol observer tests (PR-2, spec §3 / §4.4).
//
// The CLI's init frame is the AUTHORITATIVE tools/list observation (§8.1:
// the sidecar may not spawn the CLI's MCP servers). This pins the exact-set
// comparison: missing capability and unpinned surface both report, an
// unavailable package compares to nothing, and a manifest that asserts
// nothing stays honestly silent.

import { describe, expect, it } from 'vitest';

import {
  observeToolProtocol,
  protocolDriftReasonCode,
} from './tool-protocol-observer';
import type { ResolvedToolRuntime, ToolPackageHealth } from './types';

function health(overrides: Partial<ToolPackageHealth> = {}): ToolPackageHealth {
  return {
    id: 'officecli',
    version: '1.0.145',
    displayName: 'OfficeCLI',
    adoption: 'trial',
    serverName: 'trylo-office',
    state: 'installed',
    available: true,
    detail: 'ok',
    autoUpdate: false,
    expectedTools: ['officecli'],
    protocol: 'not-checked',
    checkedAt: 0,
    reportedVersion: null,
    versionMatches: null,
    ...overrides,
  };
}

function runtime(healthRecords: readonly ToolPackageHealth[]): ResolvedToolRuntime {
  return {
    profileId: 'work.core.v1',
    profileRevision: '1',
    surface: 'work',
    mcpConfigPath: 'p',
    mcpConfigHash: 'h',
    permissionSettingsPath: 's',
    permissionSettingsHash: 'sh',
    cliArgs: [],
    spawnEnv: {},
    serverNames: healthRecords.filter((h) => h.available).map((h) => h.serverName),
    packageHealth: healthRecords,
    unavailableCapabilities: [],
    strictMcpConfig: true,
    resolvedAt: 0,
  };
}

describe('observeToolProtocol', () => {
  it('an exact match reports ok with no missing or extra tools', () => {
    const records = observeToolProtocol(['mcp__trylo-office__officecli'], runtime([health()]));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ packageId: 'officecli', protocol: 'ok' });
    expect(records[0]!.missing).toEqual([]);
    expect(records[0]!.extra).toEqual([]);
  });

  it('a missing expected tool reports drift (capability silently absent)', () => {
    const records = observeToolProtocol([], runtime([health()]));
    expect(records[0]!.protocol).toBe('drift');
    expect(records[0]!.missing).toEqual(['mcp__trylo-office__officecli']);
    expect(records[0]!.extra).toEqual([]);
  });

  it('an unpinned observed tool reports drift (surface grew behind the manifest)', () => {
    const records = observeToolProtocol(
      ['mcp__trylo-office__officecli', 'mcp__trylo-office__shell'],
      runtime([health()]),
    );
    expect(records[0]!.protocol).toBe('drift');
    expect(records[0]!.extra).toEqual(['mcp__trylo-office__shell']);
  });

  it('tools of OTHER servers never count as this package\u2019s extras', () => {
    const records = observeToolProtocol(
      ['mcp__trylo-office__officecli', 'mcp__trylo-browser__navigate', 'Bash'],
      runtime([health()]),
    );
    expect(records[0]!.protocol).toBe('ok');
  });

  it('an unavailable package is skipped — its server was never injected', () => {
    const records = observeToolProtocol(
      [],
      runtime([health({ available: false, state: 'not-installed' })]),
    );
    expect(records).toEqual([]);
  });

  it('a manifest asserting nothing stays honestly silent (Playwright, PR-1 偏差③)', () => {
    const records = observeToolProtocol(
      ['mcp__trylo-browser__navigate'],
      runtime([health({ id: 'playwright', serverName: 'trylo-browser', expectedTools: [] })]),
    );
    expect(records).toEqual([]);
  });
});

describe('protocolDriftReasonCode', () => {
  it('names the package and the diff, tool names only', () => {
    expect(
      protocolDriftReasonCode({
        packageId: 'officecli',
        serverName: 'trylo-office',
        protocol: 'drift',
        missing: ['mcp__trylo-office__officecli'],
        extra: [],
      }),
    ).toBe('officecli:missing:mcp__trylo-office__officecli,extra:-');
  });

  it('is bounded in length (diagnostics reason codes are short + stable)', () => {
    const many = Array.from({ length: 40 }, (_, i) => `mcp__trylo-office__tool_${i}`);
    const code = protocolDriftReasonCode({
      packageId: 'officecli',
      serverName: 'trylo-office',
      protocol: 'drift',
      missing: many,
      extra: [],
    });
    expect(code.length).toBeLessThanOrEqual(96);
  });
});
