// Trylo Desktop — DesktopActionProvider contract (WCC-P2-03, spec §16).
//
// A provider lets a high-value task keep its APP-LEVEL semantics instead of
// degrading to UI clicks: the host routes "navigate chrome to X" to the
// Chrome DevTools provider, whose execute() maps to pinned CDP MCP tool
// calls — never raw CDP sockets, never arbitrary script execution in the
// provider host (§16 WCC-P2-03 禁止项).
//
// v1 scope (deliberate): the contract + registry + ONE provider (browser
// CDP). observe/execute/verify are host-orchestrated — the provider emits
// MCP tool calls and verification evidence; it never runs code itself.

import type { JsonSchemaLike } from './provider-json-schema'

/** App identity a provider matches against (spec §16 Provider 合同). */
export interface AppIdentity {
  readonly processName?: string
  readonly windowTitle?: string
  readonly aumid?: string
  /** Class of application the resolver derived (browser/office/cad/…). */
  readonly appClass?: 'browser' | 'office' | 'cad' | 'editor' | 'unknown'
  /** Browser identity when appClass=browser (vendor + channel). */
  readonly browser?: {
    readonly vendor: 'chrome' | 'edge' | 'chromium' | 'unknown'
    readonly channel?: string
  }
}

export type ProviderMatchConfidence = 'exact' | 'likely' | 'no'

export interface ProviderMatch {
  readonly confidence: ProviderMatchConfidence
  /** Why this provider matched (audit-safe, no user content). */
  readonly reason: string
}

/** Side-effect and retry classes mirror the ActionRequest contract. */
export type ProviderSideEffect = 'read' | 'write' | 'destructive' | 'external_communication'
export type ProviderInteractionPolicy = 'background_only' | 'may_prompt' | 'requires_foreground'
export type ProviderRetryClass = 'idempotent' | 'verify_before_retry' | 'never_retry'

/** One routable app-level action (spec §16 ActionDescriptor). */
export interface ActionDescriptor {
  readonly actionId: string
  /** MCP tool calls this action maps to (host routes via pinned manifests). */
  readonly mcpToolName: string
  readonly inputSchema: JsonSchemaLike
  readonly resultSchema: JsonSchemaLike
  readonly sideEffect: ProviderSideEffect
  readonly interactionPolicy: ProviderInteractionPolicy
  readonly retryClass: ProviderRetryClass
  readonly supportsProgress: boolean
  readonly supportsCancellation: boolean
  readonly supportsUndo: boolean
}

export interface ProviderObservationRequest {
  readonly identity: AppIdentity
  readonly windowTitle?: string
  readonly actionId?: string
}

/** Observation is a projection, not raw page content: redacted summaries
 *  only (same posture as SafeAudit). */
export interface ProviderObservation {
  readonly providerId: string
  readonly matched: boolean
  readonly availableActions: readonly ActionDescriptor[]
  readonly warnings: readonly string[]
}

export interface ProviderActionRequest {
  readonly actionId: string
  /** Validated against the action's inputSchema by the registry BEFORE
   *  execute — the provider may assume shape, never trust content. */
  readonly input: Readonly<Record<string, unknown>>
  readonly interactionPolicy: ProviderInteractionPolicy
}

export type ProviderActionResultEffect =
  'confirmed_success' | 'unknown_outcome' | 'unsupported' | 'refused'

export interface ProviderActionResult {
  readonly effect: ProviderActionResultEffect
  /** Pinned-MCP call the action was routed to (audit + UI display). */
  readonly mcpToolName: string
  readonly detail: string
  readonly warnings: readonly string[]
}

export interface ProviderVerificationRequest {
  readonly actionId: string
  readonly mcpToolName: string
  readonly input: Readonly<Record<string, unknown>>
  /** Post-state the provider may re-observe through its own MCP surface. */
  readonly postState?: Readonly<Record<string, unknown>>
}

/** Machine-readable evidence — same bar as ActionResult verification. */
export interface ProviderVerificationEvidence {
  readonly verifier: string
  readonly predicate: string
  readonly observed: string
}

/**
 * The provider contract. `match` is synchronous and pure (registry routing
 * stays deterministic); the async surface is observe/execute/verify.
 */
export interface DesktopActionProvider {
  readonly id: string
  readonly version: string
  match(target: AppIdentity): ProviderMatch
  capabilities(): readonly ActionDescriptor[]
  observe(request: ProviderObservationRequest): Promise<ProviderObservation>
  execute(request: ProviderActionRequest): Promise<ProviderActionResult>
  verify(request: ProviderVerificationRequest): Promise<ProviderVerificationEvidence>
}
