// Trylo — ManagedChildBinding store (P3 §7.3 / §8.2).
//
// The durable cross-runtime binding between a Trylo parent run/tool-use and a
// CoWork ManagedSession running in workd. Persisted by Desktop/Conversation
// history (serialized into the workspace history JSON by the caller).
//
// Rules enforced here (doc §7.3 + §8.2):
//   - Uniqueness: `managedSessionId`. One managed session maps to exactly one
//     binding.
//   - Idempotent replay: re-binding the same `parentToolUseId` returns the
//     ORIGINAL binding and never creates a second session.
//   - Recovery: non-terminal bindings are reconciled against the daemon's
//     authoritative state (managedSession.get / events.list). A missing
//     backing task → failed/orphaned (never permanently running). An
//     unreachable daemon → `unavailable` (never fabricate a replacement).

import type { ManagedChildBinding, ManagedWorkStatus } from './managedWorkTypes';

export type ManagedChildRecoveryStatus = ManagedWorkStatus | 'orphaned' | 'unavailable';

export type ManagedChildBindings = Readonly<Record<string, ManagedChildBinding>>;

const TERMINAL: ReadonlySet<ManagedWorkStatus> = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status as ManagedWorkStatus);
}

export function emptyManagedChildBindings(): ManagedChildBindings {
  return {};
}

/**
 * Idempotently bind a parent tool-use to a managed session.
 *
 * - If a binding already exists for `parentToolUseId`, it is returned unchanged
 *   and the candidate is DROPPED — replaying a tool call must never create a
 *   second session.
 * - Otherwise upsert keyed by `managedSessionId` (uniqueness), stamping
 *   `updatedAt`.
 * - If the candidate's `managedSessionId` already exists under a DIFFERENT
 *   parent tool-use, the existing binding wins (one session = one binding).
 */
export function bindManagedChild(
  bindings: ManagedChildBindings,
  candidate: ManagedChildBinding,
): { next: ManagedChildBindings; binding: ManagedChildBinding } {
  // 1) Idempotent replay: same parent tool-use → return the original binding.
  const byToolUse = findByToolUseId(bindings, candidate.parentToolUseId);
  if (byToolUse) return { next: bindings, binding: byToolUse };

  // 2) Uniqueness: the managedSessionId must be free.
  const existing = bindings[candidate.managedSessionId];
  if (existing) return { next: bindings, binding: existing };

  const stamped: ManagedChildBinding = { ...candidate, updatedAt: Date.now() };
  return {
    next: { ...bindings, [stamped.managedSessionId]: stamped },
    binding: stamped,
  };
}

/** Find the binding for a parent tool-use id (replay + approval routing). */
export function findByToolUseId(
  bindings: ManagedChildBindings,
  parentToolUseId: string,
): ManagedChildBinding | undefined {
  return Object.values(bindings).find((b) => b.parentToolUseId === parentToolUseId);
}

/** Find the binding for a managed session id. */
export function findBySessionId(
  bindings: ManagedChildBindings,
  managedSessionId: string,
): ManagedChildBinding | undefined {
  return bindings[managedSessionId];
}

/** All bindings in a non-terminal state (recovery candidates, §8.2 step 1). */
export function listActive(bindings: ManagedChildBindings): ManagedChildBinding[] {
  return Object.values(bindings).filter((b) => !isTerminalStatus(b.status));
}

/** Refresh one binding's status/timestamps in place. */
export function updateStatus(
  bindings: ManagedChildBindings,
  managedSessionId: string,
  status: string,
): ManagedChildBindings {
  const existing = bindings[managedSessionId];
  if (!existing || existing.status === status) return bindings;
  return {
    ...bindings,
    [managedSessionId]: { ...existing, status, updatedAt: Date.now() },
  };
}

/** Drop a binding (detach / session deleted). */
export function removeBinding(
  bindings: ManagedChildBindings,
  managedSessionId: string,
): ManagedChildBindings {
  if (!bindings[managedSessionId]) return bindings;
  const next = { ...bindings };
  delete next[managedSessionId];
  return next;
}

/**
 * §8.2 recovery rule applied to one non-terminal binding.
 *
 * `fetcher` is injected so the pure store stays testable:
 *   - it returns `{ ok: true, status }` with the daemon's authoritative status,
 *   - or `{ ok: false, reason: 'not_found' }` when the backing task/session no
 *     longer exists (→ orphaned, never permanently running),
 *   - or `{ ok: false, reason: 'unavailable' }` when the daemon is unreachable
 *     (→ keep the binding but mark it `unavailable`; do NOT fabricate a
 *     replacement session).
 */
export async function reconcileManagedChild(
  binding: ManagedChildBinding,
  fetcher: (b: ManagedChildBinding) => Promise<
    | { ok: true; status: string }
    | { ok: false; reason: 'not_found' | 'unavailable' }
  >,
): Promise<ManagedChildBinding> {
  if (isTerminalStatus(binding.status)) return binding;
  const result = await fetcher(binding);
  if (result.ok) {
    return { ...binding, status: result.status, updatedAt: Date.now() };
  }
  if (result.reason === 'not_found') {
    // Backing session/task is gone — a "running" binding must never stick.
    return { ...binding, status: 'orphaned', updatedAt: Date.now() };
  }
  // Daemon unreachable: surface unavailable, don't invent a replacement.
  return { ...binding, status: 'unavailable', updatedAt: Date.now() };
}

// --- Serialization (persisted inside the conversation-history JSON) ---------

/**
 * Whitelist deserialize. Unknown fields dropped; invalid entries discarded.
 * Old histories without the field normalize to `{}`.
 */
export function deserializeManagedChildBindings(value: unknown): ManagedChildBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ManagedChildBinding> = {};
  for (const [sessionId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.parentToolUseId !== 'string' || typeof r.managedSessionId !== 'string') continue;
    if (r.managedSessionId !== sessionId) continue;
    out[sessionId] = {
      childId: typeof r.childId === 'string' ? r.childId : `managed-${sessionId}`,
      projectKey: typeof r.projectKey === 'string' ? r.projectKey : '',
      conversationId: typeof r.conversationId === 'string' ? r.conversationId : '',
      parentRunId: typeof r.parentRunId === 'string' ? r.parentRunId : '',
      parentToolUseId: r.parentToolUseId,
      managedSessionId: sessionId,
      backingTaskId: typeof r.backingTaskId === 'string' ? r.backingTaskId : undefined,
      status: typeof r.status === 'string' ? r.status : 'running',
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    };
  }
  return out;
}

export function serializeManagedChildBindings(bindings: ManagedChildBindings): Record<string, unknown> {
  return Object.fromEntries(
    Object.values(bindings).map((b) => [b.managedSessionId, { ...b }]),
  );
}
