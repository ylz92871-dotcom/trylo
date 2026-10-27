import { describe, expect, it } from 'vitest';
import {
  resetCliRuntimeGuardForTests,
  verifyCliRuntime,
} from './cli-runtime-guard';
import type { CliRuntimeProbeResult } from '../host-adapter/cli-runtime-adapter';

const LEGACY_ENTRY = 'D:/tools/cli.js';
const V1_ENTRY = 'D:/tools/new-cli.js';

function probeOk(kind: 'legacy' | 'trylo-v1'): Extract<CliRuntimeProbeResult, { ok: true }> {
  return { ok: true, kind, version: 'x', evidence: `--help → ${kind}` };
}

describe('cli-runtime-guard (Round-3 P1-10: ask the binary, not the filename)', () => {
  it('blocks a positively identified old v1 build missing the requested context flags', async () => {
    resetCliRuntimeGuardForTests();
    const oldProbe=async():Promise<CliRuntimeProbeResult>=>({...probeOk('trylo-v1'),supportedFlags:['--model']});
    expect(await verifyCliRuntime({protocol:'trylo-v1',entryScript:V1_ENTRY,nodeProgram:'node',probe:oldProbe})).toEqual({ok:true});
    const verdict=await verifyCliRuntime({protocol:'trylo-v1',entryScript:V1_ENTRY,nodeProgram:'node',requiredFlags:['--context-window','--model-context-window'],probe:oldProbe});
    expect(verdict.ok).toBe(false);if(!verdict.ok)expect(verdict.message).toMatch(/npm run build/);
  });
  it('passes when the binary announces the expected kind', async () => {
    resetCliRuntimeGuardForTests();
    const verdict = await verifyCliRuntime({
      protocol: 'legacy-stream-json',
      entryScript: LEGACY_ENTRY,
      probe: async () => probeOk('legacy'),
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('BLOCKS the audit-P0 shape: legacy protocol configured, new binary on disk', async () => {
    resetCliRuntimeGuardForTests();
    const verdict = await verifyCliRuntime({
      protocol: 'legacy-stream-json',
      entryScript: V1_ENTRY,
      probe: async () => probeOk('trylo-v1'),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toMatch(/自检不通过/);
      expect(verdict.message).toMatch(/legacy/);
    }
  });

  it('BLOCKS a missing entry instead of spawning into a cryptic failure', async () => {
    resetCliRuntimeGuardForTests();
    const missing: CliRuntimeProbeResult = {
      ok: false,
      code: 'not_found',
      detail: 'no file at D:/tools/gone.js',
    };
    const verdict = await verifyCliRuntime({
      protocol: 'trylo-v1',
      entryScript: 'D:/tools/gone.js',
      probe: async () => missing,
    });
    expect(verdict.ok).toBe(false);
  });

  it('proceeds on doubt (timeout): the spawn stays the final arbiter', async () => {
    resetCliRuntimeGuardForTests();
    const timeout: CliRuntimeProbeResult = {
      ok: false,
      code: 'timeout',
      detail: 'no exit within 8000ms',
    };
    const verdict = await verifyCliRuntime({
      protocol: 'trylo-v1',
      entryScript: V1_ENTRY,
      probe: async () => timeout,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('memoizes per entry: the second send spawns no probe', async () => {
    resetCliRuntimeGuardForTests();
    let calls = 0;
    const probe = async (): Promise<CliRuntimeProbeResult> => {
      calls += 1;
      return probeOk('legacy');
    };
    await verifyCliRuntime({ protocol: 'legacy-stream-json', entryScript: LEGACY_ENTRY, probe });
    await verifyCliRuntime({ protocol: 'legacy-stream-json', entryScript: LEGACY_ENTRY, probe });
    expect(calls).toBe(1);
  });

  it('rejects an empty cliPath with an actionable message', async () => {
    resetCliRuntimeGuardForTests();
    const verdict = await verifyCliRuntime({ protocol: 'legacy-stream-json', entryScript: '  ' });
    expect(verdict.ok).toBe(false);
  });
});
