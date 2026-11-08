import type { CodePermissionRequest } from '../../runtime/code-permission-registry';
import type { ChatMessage } from './types';
import { useSyncExternalStore } from 'react';
import type { ConversationRunSupervisor } from '../../runtime/conversation-run-supervisor';
import { reconciledApprovalSubscription, type ApprovalSubscriptionSource } from '../../runtime/code-permission-reconciliation';

type ApprovalSource = ApprovalSubscriptionSource & Pick<ConversationRunSupervisor, 'getVersion'>;

/** Approval visibility follows its registry, independent of either chat's run view. */
export function useCodeApprovals(source: ApprovalSource, projectKey: string, conversationId: string | null): readonly ChatMessage[] {
  useSyncExternalStore(reconciledApprovalSubscription(source), source.getVersion);
  return codeApprovalMessages(source.pendingCodePermissions(), projectKey, conversationId);
}

/** Live registry projection, scoped by both project and conversation. */
export function codeApprovalMessages(requests: readonly CodePermissionRequest[], projectKey: string,
  conversationId: string | null): readonly ChatMessage[] {
  if (!conversationId) return [];
  return requests.filter(request => request.projectKey === projectKey && request.conversationId === conversationId)
    .map<ChatMessage>(request => ({
      id: `code-approval:${request.requestId}`, kind: 'approval', role: 'system', createdAt: request.at,
      authority: 'code', approvalId: request.requestId, type: request.toolName,
      description: request.title ?? `${request.toolName} 请求审批`, status: 'pending',
      ...(request.requester ? { requester: request.requester } : {}),
      ...(request.preview ? { preview: request.preview } : {}),
      pendingRequest: { requestId: request.requestId, projectKey: request.projectKey,
        conversationId: request.conversationId, processId: request.processId, toolName: request.toolName, input: request.input },
    }));
}

/** A stored card is a historical record, never permission authority. A stop,
 *  exit or reload must not leave old buttons actionable after its live entry
 *  has disappeared. Keep settled facts and de-duplicate recovered live cards. */
export function mergeCodeApprovals(history: readonly ChatMessage[], live: readonly ChatMessage[]): readonly ChatMessage[] {
  const pending = new Map(live.flatMap(message => message.kind === 'approval' && message.authority === 'code'
    ? [[message.approvalId, message] as const] : []));
  let changed = false;
  const merged = history.map(message => {
    if (message.kind !== 'approval' || message.authority !== 'code') return message;
    const current = pending.get(message.approvalId);
    pending.delete(message.approvalId);
    if (message.status !== 'pending') return message;
    changed = true;
    if (current) return { ...current, id: message.id };
    const { pendingRequest: _pending, ...historical } = message;
    return { ...historical, status: 'expired' as const };
  });
  if (pending.size) return [...merged, ...pending.values()];
  return changed ? merged : history;
}
