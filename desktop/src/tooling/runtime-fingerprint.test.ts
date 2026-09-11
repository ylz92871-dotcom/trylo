// Trylo Desktop — RuntimeFingerprint contract tests (spec §9).
//
// The fingerprint is the ONLY gate on warm-process reuse, so every field the
// spec names must actually move it, and every field that must NOT (keys in
// the clear, config file paths that happen to differ) must not.

import { describe, expect, it } from 'vitest';
import type { ResolvedToolRuntime } from './types';
import {
  canonicalizeCwd,
  fingerprintForRun,
  hashIdentity,
  legacyFingerprint,
  runtimeFingerprint,
} from './runtime-fingerprint';
import { spawnEnvForTeamSurface } from './team-surface-env';

const BASE = {
  cliPath: 'D:/cli/cli.js',
  cwd: 'D:/work',
  apiKey: 'sk-secret',
  apiHost: 'https://api.example.com',
  apiModel: 'model-a',
  apiFormat: 'anthropic' as const,
  systemPrompt: 'global',
  permissionLevel: 'workspace_write' as const,
  extraCliArgs: [] as readonly string[],
  toolRuntime: null as ResolvedToolRuntime | null,
};

function runtime(profileId: string): ResolvedToolRuntime {
  return {
    profileId,
    profileRevision: '1',
    surface: 'work',
    mcpConfigPath: 'D:/profiles/mcp.json',
    mcpConfigHash: `mcp-${profileId}`,
    permissionSettingsPath: 'D:/profiles/settings.json',
    permissionSettingsHash: 'set-1',
    cliArgs: ['--mcp-config', 'D:/profiles/mcp.json', '--strict-mcp-config'],
    spawnEnv: {},
    serverNames: ['trylo-office'],
    packageHealth: [],
    unavailableCapabilities: [],
    strictMcpConfig: true,
    resolvedAt: 0,
  };
}

describe('runtimeFingerprint', () => {
  it('is deterministic for identical inputs', () => {
    expect(fingerprintForRun(BASE)).toBe(fingerprintForRun(BASE));
  });

  it('degrades to the legacy argv key when no Profile was resolved (§9)', () => {
    expect(fingerprintForRun(BASE)).toBe(legacyFingerprint(BASE.extraCliArgs));
    expect(fingerprintForRun(BASE)).toBe('legacy:[]');
    // The legacy form stays argv-shaped, so a plain Code run keeps the
    // pre-PR-1 warm/prewarm behaviour byte for byte.
    expect(fingerprintForRun({ ...BASE, extraCliArgs: ['--mcp-config', 'h.json'] })).toBe(
      legacyFingerprint(['--mcp-config', 'h.json']),
    );
  });

  it('moves on every field the spec names (§9)', () => {
    // The full identity is only exercised when a Profile was resolved; with
    // `toolRuntime: null` the legacy argv key is authoritative and the other
    // fields are intentionally invisible (that is the compat contract).
    const base = fingerprintForRun({ ...BASE, toolRuntime: runtime('work.core.v1') });
    const variants: [string, unknown][] = [
      ['apiModel', 'model-b'],
      ['apiHost', 'https://other.example.com'],
      ['apiFormat', 'openai'],
      ['apiKey', 'sk-other'],
      ['apiKeyHeader', 'x-api-key'],
      ['apiKeyPrefix', 'Bearer '],
      ['extraHeadersText', '{"x":"y"}'],
      ['systemPrompt', 'other prompt'],
      ['permissionLevel', 'read_only'],
    ];
    for (const [field, value] of variants) {
      const changed = fingerprintForRun({
        ...BASE,
        [field]: value,
        toolRuntime: runtime('work.core.v1'),
      } as typeof BASE);
      expect(changed, `fingerprint must move when ${field} changes`).not.toBe(base);
    }
    // With a Profile resolved, the identity is CONTENT-ADDRESSED (§4.2): the
    // config hash decides, not the argv. A config change moves the hash and
    // therefore the fingerprint.
    const changedConfig = fingerprintForRun({
      ...BASE,
      toolRuntime: { ...runtime('work.core.v1'), mcpConfigHash: 'mcp-other' },
    });
    expect(changedConfig).not.toBe(base);
    // Conversely, an argv that differs while the config content hash matches
    // is the SAME contract — intentional, because the hash is derived from
    // the very content the argv points at.
    const sameContractDifferentArgv = fingerprintForRun({
      ...BASE,
      toolRuntime: { ...runtime('work.core.v1'), cliArgs: ['--mcp-config', 'renamed.json'] },
    });
    expect(sameContractDifferentArgv).toBe(base);
  });

  it('moves when the Profile changes, and with it the config hash', () => {
    const a = fingerprintForRun({ ...BASE, toolRuntime: runtime('work.core.v1') });
    const b = fingerprintForRun({ ...BASE, toolRuntime: runtime('work.cad.v1') });
    expect(a).not.toBe(b);
    // A Profile revision bump means a new runtime contract even when the id
    // is unchanged.
    const c = fingerprintForRun({
      ...BASE,
      toolRuntime: { ...runtime('work.core.v1'), profileRevision: '2' },
    });
    expect(c).not.toBe(a);
    // Same profile content re-derives the same identity → warm reuse works.
    expect(fingerprintForRun({ ...BASE, toolRuntime: runtime('work.core.v1') })).toBe(a);
  });

  it('never carries the API key in the clear (§9)', () => {
    const fingerprint = fingerprintForRun({ ...BASE, toolRuntime: runtime('work.core.v1') });
    expect(fingerprint).not.toContain('sk-secret');
    // Different keys must still be distinguishable.
    expect(fingerprintForRun({ ...BASE, apiKey: 'sk-other', toolRuntime: runtime('work.core.v1') })).not.toBe(fingerprint);
    // The legacy degrade path never sees a key either.
    expect(fingerprintForRun(BASE)).not.toContain('sk-secret');
  });

  it('Work degrade env is not the Code legacy fingerprint', () => {
    const code = fingerprintForRun(BASE);
    const work = fingerprintForRun({
      ...BASE,
      spawnEnv: { TRYLO_TEAM_SURFACE: 'work' },
    });
    expect(code).toBe('legacy:[]');
    expect(work).not.toBe(code);
    expect(work).toContain('env:');
    expect(fingerprintForRun({
      ...BASE,
      spawnEnv: { TRYLO_TEAM_SURFACE: 'work' },
    })).toBe(work);
  });

  it('treats spawn env as part of the contract (§9)', () => {
    const a = runtimeFingerprint({
      cliPath: 'D:/cli/cli.js',
      cliBinaryHash: '',
      cwdCanonical: 'd:/work',
      providerFormat: 'anthropic',
      apiHost: '',
      model: '',
      authIdentityHash: 'x',
      permissionLevel: 'ask',
      systemPromptHash: 's',
      toolProfileId: 'p',
      toolProfileRevision: '1',
      mcpConfigHash: 'm',
      permissionSettingsHash: 'ps',
      spawnEnv: { A: '1' },
      extraCliArgs: [],
    });
    const b = runtimeFingerprint({
      cliPath: 'D:/cli/cli.js',
      cliBinaryHash: '',
      cwdCanonical: 'd:/work',
      providerFormat: 'anthropic',
      apiHost: '',
      model: '',
      authIdentityHash: 'x',
      permissionLevel: 'ask',
      systemPromptHash: 's',
      toolProfileId: 'p',
      toolProfileRevision: '1',
      mcpConfigHash: 'm',
      permissionSettingsHash: 'ps',
      spawnEnv: { A: '2' },
      extraCliArgs: [],
    });
    expect(a).not.toBe(b);
  });
});

describe('spawnEnvForTeamSurface', () => {
  it('injects TRYLO_TEAM_SURFACE only for Work', () => {
    expect(spawnEnvForTeamSurface('code')).toEqual({});
    expect(spawnEnvForTeamSurface(undefined, { A: '1' })).toEqual({ A: '1' });
    expect(spawnEnvForTeamSurface('work')).toEqual({ TRYLO_TEAM_SURFACE: 'work' });
    expect(spawnEnvForTeamSurface('work', { A: '1' })).toEqual({
      A: '1',
      TRYLO_TEAM_SURFACE: 'work',
    });
  });
});

describe('canonicalizeCwd', () => {
  it('normalises separators, drive case and trailing slashes', () => {
    expect(canonicalizeCwd('D:\\Work\\proj\\')).toBe('d:/Work/proj');
    expect(canonicalizeCwd('D:/work')).toBe(canonicalizeCwd('D:\\work'));
    // Only the drive letter is case-folded — the rest is left alone.
    expect(canonicalizeCwd('D:/Work')).toBe('d:/Work');
  });
});

describe('hashIdentity', () => {
  it('is order-sensitive and stable', () => {
    expect(hashIdentity(['a', 'b'])).toBe(hashIdentity(['a', 'b']));
    expect(hashIdentity(['a', 'b'])).not.toBe(hashIdentity(['b', 'a']));
    // 64-bit identity: distinct inputs must not collapse in practice.
    const seen = new Set(Array.from({ length: 2000 }, (_, i) => hashIdentity([`case-${i}`])));
    expect(seen.size).toBeGreaterThan(1990);
  });
});
