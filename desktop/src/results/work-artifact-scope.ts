// Trylo Desktop — Work artifact event scope resolution (P2-1, spec §8.3;
// hardened by the 2026-08-27 final audit, P1-2).
//
// Extracted as a pure function (no React / Tauri) so the "fixed scope rule"
// is unit-testable: the Work run registry binding is the ONLY ownership
// authority for an artifact event. The identity fields the event itself
// carries (`conversationId` / `runId` / `turnId`) are VALIDATION-ONLY — when
// both the event and the binding carry a field they must agree exactly, and
// the resolved scope takes every ownership field from the binding, never
// from the event, never from the currently selected workspace. A missing
// binding or any mismatch is a dropped resolution (the host surfaces it as a
// Diagnostics record), not a silent write into an invented scope.

import { type WorkArtifactScope } from '@trylo/work';
import { workspaceKey } from '../host-adapter/conversation-history';

/** The registry-shaped binding lookup the resolver needs. Structurally
 *  satisfied by the Work package's `TaskRecord`, which already carries
 *  `conversationId` — the registry binding is the sole ownership source. */
export interface WorkRunBinding {
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly turnId?: string | undefined;
}

/** A resolved artifact projection ready for the WorkResultProjector. */
export interface ResolvedArtifactProjection {
  readonly scope: WorkArtifactScope;
  readonly rawPath: string;
  readonly artifactKind?: string;
}

export type ArtifactScopeResolution =
  | { readonly ok: true; readonly projection: ResolvedArtifactProjection }
  | { readonly ok: false; readonly droppedReason: string };

/**
 * Resolve the scope for one event-discovered artifact (spec §8.3, audit
 * P1-2).
 *
 * The caller guarantees `item.taskId` exists; a taskId with no registry
 * binding is always dropped. Every identity the event carries is a
 * cross-check against the binding — never an ownership source:
 *   - `conversationId` must equal the binding's (an event that cannot
 *     identify its conversation cannot be validated and is dropped);
 *   - `runId` must equal the binding's (a mismatch marks the event as a
 *     stale emission from a superseded run of the same durable task);
 *   - `turnId`, when present on BOTH sides, must agree.
 * The resolved scope's ownership fields come exclusively from the binding.
 */
export function resolveArtifactProjection(
  taskId: string,
  runId: string,
  turnId: string | undefined,
  conversationId: string,
  at: number,
  filePath: string,
  artifactKind: string | undefined,
  getBinding: (taskId: string) => WorkRunBinding | undefined,
): ArtifactScopeResolution {
  const binding = getBinding(taskId);
  if (!binding) {
    return { ok: false, droppedReason: `no registry binding for taskId ${taskId}` };
  }
  if (!conversationId) {
    return {
      ok: false,
      droppedReason: `event for taskId ${taskId} carries no conversationId to validate`,
    };
  }
  if (conversationId !== binding.conversationId) {
    return {
      ok: false,
      droppedReason:
        `event conversationId ${conversationId} !== binding conversationId ${binding.conversationId}`,
    };
  }
  if (!runId) {
    return {
      ok: false,
      droppedReason: `event for taskId ${taskId} carries no runId to validate`,
    };
  }
  if (runId !== binding.runId) {
    return {
      ok: false,
      droppedReason: `event runId ${runId} !== binding runId ${binding.runId} (stale run)`,
    };
  }
  if (turnId !== undefined && binding.turnId !== undefined && turnId !== binding.turnId) {
    return {
      ok: false,
      droppedReason: `event turnId ${turnId} !== binding turnId ${binding.turnId}`,
    };
  }
  return {
    ok: true,
    projection: {
      scope: {
        projectKey: workspaceKey(binding.projectRoot),
        projectRoot: binding.projectRoot,
        conversationId: binding.conversationId,
        taskId: binding.taskId,
        runId: binding.runId,
        turnId: binding.turnId,
        startedAt: at,
      },
      rawPath: filePath,
      artifactKind,
    },
  };
}