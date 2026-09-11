/**
 * Headless-safe types for the ManagedSession runtime core.
 *
 * This module MUST NOT import any Electron runtime package or any module that
 * statically loads `electron`. It only depends on `better-sqlite3` (via the
 * injected database handle), the headless-safe repositories, and shared types.
 */

import type {
  AgentBuilderConnectionRequirement,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionEvent,
  ManagedSessionInputContent,
  ManagedSessionStatus,
  ManagedSessionSurface,
  ManagedSessionEventType,
  ManagedAgentVersion,
} from "../../shared/types";

/**
 * Result of resolving which MCP tools a ManagedEnvironment is allowed to use.
 * The headless core ships a fail-closed default (every referenced MCP server is
 * "missing"); callers running under Electron can inject their real MCP-registry
 * resolver so the composed agentConfig / root prompt reflect actual tool access.
 */
export interface ManagedMcpToolAccessResolver {
  (environment: ManagedEnvironment): {
    allowedTools: string[];
    missingConnections: AgentBuilderConnectionRequirement[];
    hasMcpServerAllowlist: boolean;
    blockingError?: string;
  };
}

/**
 * Workspace permission check selector. This intentionally mirrors the subset of
 * checks used by the Electron ManagedSessionService, but the runtime core does
 * NOT import any Electron permission module. Callers decide how to enforce it.
 */
export type ManagedRuntimePermissionCheck =
  | "canViewAgents"
  | "canRunAgents"
  | "canResumeSessions"
  | "canAnswerApprovals";

/**
 * Injection hook for workspace permission enforcement in headless contexts.
 *
 * The hook is mandatory. A caller that intentionally trusts an outer boundary
 * must make that decision explicit by injecting a no-op assertion.
 */
export type ManagedPermissionAssertion = (
  workspaceId: string,
  check: ManagedRuntimePermissionCheck,
  principalId?: string,
) => void;

/**
 * Upgrade-safe accessor for a ManagedSession event payload in a decoupled
 * consumer (e.g. the daemon control-plane transport layer). Consumers should
 * NOT read the raw `payload` object they might receive from a transport; use
 * this to normalize to a plain object.
 */
export function toManagedEventPayload(event: ManagedSessionEvent): Record<string, unknown> {
  if (!event) return {};
  const payload = event.payload;
  if (!payload) return {};
  if (typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
  return {};
}

export interface ManagedSessionCreateParams {
  agentId: string;
  environmentId: string;
  title: string;
  surface?: ManagedSessionSurface;
  initialEvent?: {
    type: "user.message";
    content: ManagedSessionInputContent[];
  };
}

export interface ManagedSessionSendEventParams {
  sessionId: string;
  event:
    | { type: "user.message"; content: ManagedSessionInputContent[] }
    | {
        type: "input.received";
        requestId: string;
        answers?: Record<string, unknown>;
        status?: string;
      };
}

export interface ManagedSessionRuntimeOptions {
  /**
   * Required permission enforcement hook (see {@link ManagedPermissionAssertion}).
   * The runtime never silently falls back to allow.
   */
  assertPermission: ManagedPermissionAssertion;
  /**
   * Optional MCP tool-access resolver. When omitted the core uses a fail-closed
   * default (every referenced MCP server is "missing"). Inject under Electron so
   * the composed agentConfig / root prompt reflect real MCP tool allowlists.
   */
  resolveMcpToolAccess?: ManagedMcpToolAccessResolver;
  /**
   * Optional logger. Defaults to console.
   */
  log?: Pick<Console, "info" | "warn" | "error">;
}

export interface ManagedSessionBridgeEvent {
  eventId?: string;
  timestamp?: number;
  type: string;
  payload?: unknown;
  status?: string;
}

export interface ManagedSessionBridgeResult {
  session?: ManagedSession;
  appended?: ManagedSessionEvent;
}

export type {
  ManagedAgentVersion,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionEvent,
  ManagedSessionEventType,
  ManagedSessionStatus,
};
