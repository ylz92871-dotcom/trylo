import type { ProcessRecoveryIdentity } from './process-service'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Legacy team identities remain readable; ordinary turns never pretend to be teams. */
export function readProcessRecoveryIdentity(value: unknown): ProcessRecoveryIdentity | null {
  if (!object(value) || !identifier(value.turnId)) return null
  if (value.kind === 'conversation') {
    return identifier(value.runId) && value.teamRunId === undefined
      ? { kind: 'conversation', runId: value.runId, turnId: value.turnId }
      : null
  }
  if (
    (value.kind === undefined || value.kind === 'team') &&
    identifier(value.teamRunId) &&
    value.runId === undefined
  ) {
    return {
      ...(value.kind === undefined ? {} : { kind: 'team' as const }),
      teamRunId: value.teamRunId,
      turnId: value.turnId,
    }
  }
  return null
}

export function isConversationRecoveryIdentity(
  identity: ProcessRecoveryIdentity,
): identity is Extract<ProcessRecoveryIdentity, { readonly kind: 'conversation' }> {
  return identity.kind === 'conversation'
}

export function isTeamRecoveryIdentity(
  identity: ProcessRecoveryIdentity,
): identity is Exclude<ProcessRecoveryIdentity, { readonly kind: 'conversation' }> {
  return !isConversationRecoveryIdentity(identity)
}

export function processRecoveryIdentityKey(identity: ProcessRecoveryIdentity): string {
  return JSON.stringify(
    isConversationRecoveryIdentity(identity)
      ? ['conversation', identity.runId, identity.turnId]
      : ['team', identity.teamRunId, identity.turnId],
  )
}

export function sameProcessRecoveryIdentity(
  a: ProcessRecoveryIdentity,
  b: ProcessRecoveryIdentity,
): boolean {
  return processRecoveryIdentityKey(a) === processRecoveryIdentityKey(b)
}
