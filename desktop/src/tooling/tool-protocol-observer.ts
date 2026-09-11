// Trylo Desktop — Tool protocol observer (tools/list vs expectedTools).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3 (expectedTools is an
// EXACT set — drift is degraded, never a silent compatibility shim) and the
// PR-1 deviation ② follow-up: the sidecar cannot perform the `tools/list`
// handshake without violating §8.1 process ownership, so the AUTHORITATIVE
// observation is the tool list the CLI reports in its init frame. This pure
// module compares that observation against the Profile's per-package
// expectations; the controller records the drift in run diagnostics.
//
// Only AVAILABLE packages are compared (an unavailable package was never
// injected, so there is nothing to compare) and packages whose manifest
// asserts nothing (`expectedTools: []` — Playwright until PR-3) stay
// `not asserted` rather than faking a pass.

import type { ResolvedToolRuntime } from './types';

export interface ToolProtocolObservation {
  readonly packageId: string;
  readonly serverName: string;
  readonly protocol: 'ok' | 'drift';
  /** Expected tool names the CLI did NOT report (missing capability). */
  readonly missing: readonly string[];
  /** Observed tools on this server the manifest does NOT pin (surface drift). */
  readonly extra: readonly string[];
}

/** Full tool names the CLI reported at init (`mcp__<server>__<tool>`). */
export function observeToolProtocol(
  observedTools: readonly string[],
  runtime: ResolvedToolRuntime,
): readonly ToolProtocolObservation[] {
  const out: ToolProtocolObservation[] = [];
  for (const health of runtime.packageHealth) {
    if (!health.available) continue;
    if (health.expectedTools.length === 0) continue;
    const prefix = `mcp__${health.serverName}__`;
    const expected = health.expectedTools.map((tool) => `${prefix}${tool}`);
    const forServer = observedTools.filter((name) => name.startsWith(prefix));
    const missing = expected.filter((name) => !observedTools.includes(name));
    const extra = forServer.filter((name) => !expected.includes(name));
    out.push({
      packageId: health.id,
      serverName: health.serverName,
      protocol: missing.length > 0 || extra.length > 0 ? 'drift' : 'ok',
      missing,
      extra,
    });
  }
  return out;
}

/** Short, stable machine code for the diagnostics buffer (§4.4: package id +
 *  tools/list 差异 — tool names only, never paths or content). */
export function protocolDriftReasonCode(record: ToolProtocolObservation): string {
  const missing = record.missing.join('|') || '-';
  const extra = record.extra.join('|') || '-';
  const code = `${record.packageId}:missing:${missing},extra:${extra}`;
  return code.length > 96 ? code.slice(0, 96) : code;
}

export default observeToolProtocol;
