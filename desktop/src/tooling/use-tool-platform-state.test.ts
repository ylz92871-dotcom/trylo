// Trylo Desktop — Tool Platform state machine tests (audit P0-A §3.3).
//
// Pins the acceptance behaviour of the settings state machine and the
// pre-send capability gate:
//   - the §3.3 fixed state machine (未安装→安装中→校验中→可用 / 失败分支);
//   - hash / version drift and condition-missing NEVER read as 可用;
//   - the capability gate degrades non-blocking but BLOCKS a request that
//     explicitly needs a missing capability (阻止伪开工);
//   - browser-capability alternation (playwright OR chrome-devtools).

import { describe, expect, it } from 'vitest';

import type { ToolPackageHealth } from '../services-host/methods';
import {
  actionFor,
  decideSendCapabilityGate,
  derivePackageView,
  fixedInstallError,
  fixedStateMessage,
  type CapabilityGateDecision,
} from './use-tool-platform-state';

/** Narrow a decision so TS sees the notice/missingIds fields. */
function expectBehavior<T extends CapabilityGateDecision['behavior']>(
  decision: CapabilityGateDecision,
  behavior: T,
): Extract<CapabilityGateDecision, { behavior: T }> {
  expect(decision.behavior).toBe(behavior);
  return decision as Extract<CapabilityGateDecision, { behavior: T }>;
}

function health(overrides: Partial<ToolPackageHealth> = {}): ToolPackageHealth {
  return {
    id: 'officecli',
    version: '1.0.145',
    displayName: 'OfficeCLI',
    adoption: 'trial',
    serverName: 'trylo-office',
    state: 'installed',
    available: true,
    detail: 'version verified: 1.0.145',
    autoUpdate: false,
    expectedTools: ['officecli'],
    protocol: 'not-checked',
    checkedAt: 0,
    reportedVersion: '1.0.145',
    versionMatches: true,
    ...overrides,
  };
}

describe('fixedStateMessage (固定错误文案)', () => {
  it('says 未安装 for a missing package', () => {
    expect(fixedStateMessage(health({ state: 'not-installed', available: false }))).toBe('未安装');
  });

  it('never dresses a hash mismatch as usable', () => {
    const msg = fixedStateMessage(health({ state: 'hash-mismatch', available: false }));
    expect(msg).toContain('hash 不符');
    expect(msg).toContain('卸载');
  });

  it('names the pinned version on drift', () => {
    const msg = fixedStateMessage(health({ state: 'version-mismatch', available: false }));
    expect(msg).toContain('1.0.145');
    expect(msg).toContain('版本漂移');
  });

  it('tells playwright users the browser body is the missing piece', () => {
    const msg = fixedStateMessage(health({
      id: 'playwright',
      displayName: 'Playwright MCP',
      state: 'condition-missing',
      available: false,
    }));
    expect(msg).toContain('浏览器本体');
    expect(msg).toContain('安装浏览器');
  });
});

describe('derivePackageView (§3.3 state machine)', () => {
  it('未安装 → 安装中 → 校验中 → 可用', () => {
    const pkg = health({ state: 'not-installed', available: false });
    expect(derivePackageView(pkg, undefined).uiState).toBe('unusable');
    expect(derivePackageView(pkg, undefined).action).toBe('install');

    const installing = derivePackageView(pkg, { kind: 'installing' });
    expect(installing.uiState).toBe('installing');
    expect(installing.action).toBe('none');

    const verifying = derivePackageView(pkg, { kind: 'verifying' });
    expect(verifying.uiState).toBe('verifying');

    const done = derivePackageView(health(), undefined);
    expect(done.uiState).toBe('available');
    expect(done.action).toBe('uninstall');
  });

  it('an install failure shows the fixed failure text, not silence', () => {
    const view = derivePackageView(health({ state: 'not-installed', available: false }), {
      kind: 'failed',
      message: '下载失败：无法取得固定版本的发布物。请检查网络后重试。',
    });
    expect(view.uiState).toBe('install-failed');
    expect(view.message).toContain('下载失败');
    expect(view.action).toBe('retry');
  });

  it('condition-missing offers the browser install, never 可用', () => {
    const pkg = health({
      id: 'playwright',
      state: 'condition-missing',
      available: false,
      condition: { ok: false, reasonCode: 'browser_not_installed', detail: 'missing' },
    });
    const view = derivePackageView(pkg, undefined);
    expect(view.uiState).toBe('unusable');
    expect(view.action).toBe('install-browser');
  });
});

describe('decideSendCapabilityGate (§3.3-5 pre-send gate)', () => {
  it('allows a healthy Profile', () => {
    expect(decideSendCapabilityGate('写个周报', [])).toEqual({ behavior: 'allow' });
  });

  it('degrades non-blocking when nothing in the text needs the missing tools', () => {
    const decision = expectBehavior(
      decideSendCapabilityGate('写一份周报保存到 .trylo/out', [
        { id: 'officecli', type: 'package', displayName: 'OfficeCLI', userMessage: 'OfficeCLI（1.0.145）不可用' },
      ]),
      'degrade',
    );
    expect(decision.notice).toContain('OfficeCLI');
    expect(decision.notice).toContain('Work 工具');
  });

  it('the degrade notice shows display names, never the raw detail', () => {
    const decision = expectBehavior(
      decideSendCapabilityGate('写一份周报保存到 .trylo/out', [
        {
          id: 'playwright',
          type: 'package',
          displayName: 'Playwright MCP',
          userMessage: "Playwright MCP（0.0.79）不可用：pinned playwright 0.0.79 is not installed at C:\\Users\\x\\tool-packages",
        },
      ]),
      'degrade',
    );
    expect(decision.notice).toContain('Playwright MCP');
    expect(decision.notice).not.toContain('C:\\Users');
    expect(decision.notice).not.toContain('pinned playwright');
  });

  it('blocks a pseudo-start when the request explicitly needs office', () => {
    const decision = expectBehavior(
      decideSendCapabilityGate('生成一份会议纪要 docx', [
        { id: 'officecli', type: 'package', userMessage: 'OfficeCLI（1.0.145）不可用' },
      ]),
      'block',
    );
    expect(decision.notice).toContain('已阻止发送');
    expect(decision.missingIds).toContain('officecli');
  });

  it('blocks desktop-control requests when windows-mcp is missing', () => {
    expectBehavior(
      decideSendCapabilityGate('截取当前桌面并描述', [
        { id: 'windows-mcp', type: 'package', userMessage: 'Windows-MCP 不可用' },
      ]),
      'block',
    );
  });

  it('treats the browser capability as satisfied when EITHER browser package is present', () => {
    expectBehavior(
      decideSendCapabilityGate('打开 example.com 网页', [
        // playwright missing but chrome-devtools available → degrade, not block
        { id: 'playwright', type: 'package', userMessage: 'Playwright MCP 不可用' },
      ]),
      'degrade',
    );
  });

  it('blocks the browser request when BOTH browser packages are missing', () => {
    expectBehavior(
      decideSendCapabilityGate('打开 example.com 网页', [
        { id: 'playwright', type: 'package', userMessage: 'Playwright MCP 不可用' },
        { id: 'chrome-devtools', type: 'package', userMessage: 'Chrome DevTools MCP 不可用' },
      ]),
      'block',
    );
  });

  it('ignores adapter-level degradation (hermes) for blocking', () => {
    expect(decideSendCapabilityGate('生成 docx', [
      { id: 'hermes', type: 'adapter' },
    ]).behavior).toBe('allow');
  });
});

describe('fixedInstallError', () => {
  it('says exactly what is missing for a uv-less machine', () => {
    const msg = fixedInstallError('windows-mcp', 'uv_missing', undefined);
    expect(msg).toContain('uv');
    expect(msg).toContain('Windows-MCP');
  });

  it('keeps hash failures absolute (no silent install)', () => {
    expect(fixedInstallError('officecli', 'hash_mismatch', undefined)).toContain('hash 不符');
  });

  it('falls back to a fixed message without leaking the raw error (§3.3)', () => {
    // The raw error may carry absolute paths / English internals — never
    // rendered verbatim (2026-09-03 acceptance: raw EBUSY in the UI).
    expect(fixedInstallError('officecli', 'weird_code', 'boom')).toBe(
      '安装失败（weird_code）。请重试；反复失败请查看诊断日志。',
    );
  });

  it('maps the locked-target failure to a fixed actionable text', () => {
    expect(fixedInstallError('playwright', 'target_locked', undefined)).toContain('被占用');
    expect(
      fixedInstallError('playwright', 'install_failed', "EBUSY: resource busy or locked, rmdir 'C:\\Users\\x\\tool-packages\\playwright'"),
    ).toContain('被占用');
  });

  it('maps transport timeouts and a dead service host to fixed text', () => {
    expect(fixedInstallError('officecli', 'TIMEOUT', 'service host request timed out after 900000ms')).toContain('超时');
    expect(fixedInstallError('officecli', 'NOT_CONNECTED', 'service host client stopped')).toContain('工具服务不可用');
  });
});

describe('actionFor coverage', () => {
  it('never offers an action while a transition is in flight', () => {
    const pkg = health({ state: 'not-installed', available: false });
    for (const state of ['checking', 'installing', 'verifying'] as const) {
      expect(actionFor(pkg, state)).toBe('none');
    }
  });
});
