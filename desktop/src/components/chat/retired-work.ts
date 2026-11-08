import type { SubagentMessage } from './types';

/** A persisted spawn can predate the receipt that supplied its session id. */
export function isRetiredManagedWork(
  message: Pick<SubagentMessage, 'agentType' | 'managedSessionId'>,
): boolean {
  return message.agentType === 'managed-work' || Boolean(message.managedSessionId);
}
