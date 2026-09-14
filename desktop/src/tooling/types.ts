// Trylo Desktop — Tool Platform shared types (renderer side).
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §4.2 / §12.1.
//
// This module is the renderer's vocabulary for the tool control plane. It
// re-exports the Service Host protocol shapes (single source of truth) and
// adds the two request types only the renderer needs.

import type { PermissionLevel } from '../permission/permission-policy'
import type {
  ResolvedToolRuntime,
  ToolSurface,
  ToolUnavailableCapability,
} from '../services-host/methods'

export type {
  ResolvedToolRuntime,
  ToolPackageHealth,
  ToolSurface,
  ToolUnavailableCapability,
  ToolUnavailableReasonCode,
  ToolingHealthResult,
  ToolingInstallResult,
  ToolingLocalOverrideMutationResult,
  ToolingLocalOverridesResult,
  ToolingListProfilesResult,
  ToolingUninstallResult,
} from '../services-host/methods'

// PR-2: host risk-classifier vocabulary (§6.2). The shapes live in
// tool-risk-classifier.ts; re-exported here so callers have ONE tooling
// type module to import from.
export type {
  BrowserLeaseGrant,
  PackageRiskClassifier,
  SafeAudit,
  TargetReceipt,
  ToolClassifyRequest,
  ToolLeaseGrant,
  ToolRiskClass,
  ToolRiskContext,
  ToolRiskDecision,
  ToolRiskRoute,
  ToolRiskRouter,
  WindowsLeaseGrant,
} from './tool-risk-classifier'

// WCC-P2-01: server-resolved target identity. The classifier is the
// definition site; re-exported so runtime/UI code never redefines the
// receipt shape.
export { targetReceiptOf, TARGET_RECEIPT_INPUT_KEY } from './classifiers/windows-mcp-classifier'

// WCC-P2-03: DesktopActionProvider vocabulary. The contract lives in
// tooling/providers; re-exported so call sites have one tooling module.
export type {
  ActionDescriptor,
  AppIdentity,
  DesktopActionProvider,
  ProviderActionRequest,
  ProviderActionResult,
  ProviderMatch,
  ProviderObservation,
  ProviderObservationRequest,
  ProviderVerificationEvidence,
  ProviderVerificationRequest,
} from './providers/provider-contract'
export { createProviderRegistry, ProviderRegistry } from './providers/provider-registry'

// WCC-P2-03 第二批: host-side observe/verify wiring. The watcher rides the
// existing CDP tool stream; re-exported so App/UI import from one module.
export {
  createProviderObservationWatcher,
  providerRoutingLabelForTool,
} from './providers/provider-observation-watcher'
export type {
  ProviderRoutingFact,
  ProviderVerifyRecord,
  ProviderWatchOutcome,
} from './providers/provider-observation-watcher'

/**
 * What the runtime must know to compose one run's tool surface.
 *
 * Replaces the old context-free `() => Promise<string[]>` Hermes resolver:
 * a Profile cannot be chosen without knowing whether the run comes from
 * Code or Work (spec §1.1 / §4.2).
 */
export interface ResolveToolRuntimeRequest {
  readonly surface: ToolSurface
  /** Omit to use the surface default (`code.core.v1` / `work.core.v1`). */
  readonly requestedProfileId?: string
  /** 电脑控制 switch (`settings.workComputer`). `false` on a Work surface drops
   *  the Windows desktop-control package (windows-mcp) from the resolved
   *  Profile. Omitted / `true` keeps it. */
  readonly computerUse?: boolean
  readonly projectKey: string
  readonly projectRoot: string
  readonly conversationId: string
  readonly permissionLevel: PermissionLevel
}

/**
 * Resolves `null` when the tool plane is unavailable. `null` is a VALID,
 * expected answer meaning "run without a Profile" — the caller degrades to
 * the legacy Hermes args, it does not fail the run (spec §4.4).
 */
export type ToolRuntimeResolver = (
  request: ResolveToolRuntimeRequest,
) => Promise<ResolvedToolRuntime | null>

/** Capabilities this run was asked for but cannot provide (§4.4). */
export type UnavailableCapability = ToolUnavailableCapability

/**
 * A one-line, UI-ready summary of a degraded tool surface. Built from
 * `unavailableCapabilities` — the raw `detail` may carry an absolute path
 * and is never rendered into a chat bubble.
 */
export function describeUnavailableCapabilities(
  capabilities: readonly ToolUnavailableCapability[],
): string | null {
  if (capabilities.length === 0) return null
  const head = capabilities.filter((c) => c.type === 'package').map((c) => c.displayName ?? c.id)
  if (head.length === 0) return null
  return `本次运行不可用：${head.join('、')}`
}
