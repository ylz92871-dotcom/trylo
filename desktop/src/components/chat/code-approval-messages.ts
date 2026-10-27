import type { CodePermissionRequest } from '../../runtime/code-permission-registry';
import type { ChatMessage } from './types';
import { useSyncExternalStore } from 'react';
import type { ConversationRunSupervisor } from '../../runtime/conversation-run-supervisor';

type ApprovalSource = Pick<ConversationRunSupervisor, 'subscribe' | 'getVersion' | 'pendingCodePermissions'>;

/** Approval visibility follows its registry, independent of either chat's run view. */
export function useCodeApprovals(source: ApprovalSource, projectKey: string, conversationId: string | null): readonly ChatMessage[] {
  useSyncExternalStore(source.subscribe, source.getVersion);
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
