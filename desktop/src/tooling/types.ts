// Trylo Desktop — Tool Platform shared types (renderer side).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §4.2 / §12.1.
//
// This module is the renderer's vocabulary for the tool control plane. It
// re-exports the Service Host protocol shapes (single source of truth) and
// adds the two request types only the renderer needs.

import type { PermissionLevel } from '../permission/permission-policy';
import type {
  ResolvedToolRuntime,
  ToolSurface,
  ToolUnavailableCapability,
} from '../services-host/methods';

export type {
  ResolvedToolRuntime,
  ToolPackageHealth,
  ToolSurface,
  ToolUnavailableCapability,
  ToolUnavailableReasonCode,
  ToolingHealthResult,
  ToolingInstallResult,
  ToolingListProfilesResult,
  ToolingUninstallResult,
} from '../services-host/methods';

// PR-2: host risk-classifier vocabulary (§6.2). The shapes live in
// tool-risk-classifier.ts; re-exported here so callers have ONE tooling
// type module to import from.
export type {
  BrowserLeaseGrant,
  PackageRiskClassifier,
  SafeAudit,
  ToolClassifyRequest,
  ToolLeaseGrant,
  ToolRiskClass,
  ToolRiskContext,
  ToolRiskDecision,
  ToolRiskRoute,
  ToolRiskRouter,
  WindowsLeaseGrant,
} from './tool-risk-classifier';

/**
 * What the runtime must know to compose one run's tool surface.
 *
 * Replaces the old context-free `() => Promise<string[]>` Hermes resolver:
 * a Profile cannot be chosen without knowing whether the run comes from
 * Code or Work (spec §1.1 / §4.2).
 */
export interface ResolveToolRuntimeRequest {
  readonly surface: ToolSurface;
  /** Omit to use the surface default (`code.core.v1` / `work.core.v1`). */
  readonly requestedProfileId?: string;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly permissionLevel: PermissionLevel;
}

/**
 * Resolves `null` when the tool plane is unavailable. `null` is a VALID,
 * expected answer meaning "run without a Profile" — the caller degrades to
 * the legacy Hermes args, it does not fail the run (spec §4.4).
 */
export type ToolRuntimeResolver = (
  request: ResolveToolRuntimeRequest,
) => Promise<ResolvedToolRuntime | null>;

/** Capabilities this run was asked for but cannot provide (§4.4). */
export type UnavailableCapability = ToolUnavailableCapability;

/**
 * A one-line, UI-ready summary of a degraded tool surface. Built from
 * `unavailableCapabilities` — the raw `detail` may carry an absolute path
 * and is never rendered into a chat bubble.
 */
export function describeUnavailableCapabilities(
  capabilities: readonly ToolUnavailableCapability[],
): string | null {
  if (capabilities.length === 0) return null;
  const head = capabilities
    .filter((c) => c.type === 'package')
    .map((c) => c.displayName ?? c.id);
  if (head.length === 0) return null;
  return `本次运行不可用：${head.join('、')}`;
}
