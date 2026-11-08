import type { ReactElement } from 'react';
import { ApprovalCard } from '../../../components/chat/ApprovalCard';
import type { ApprovalMessage, ChatMessage } from '../../../components/chat/types';
import { isLiveCodeApproval, type HostedApprovalIdentity, type LiveCodeApproval } from '../../../components/chat/ConversationPresentation';

export interface TeamApprovalPresentation {
  readonly requests: readonly ApprovalMessage[];
  readonly hostedApprovals: readonly HostedApprovalIdentity[];
}

function liveHandleKey(message: LiveCodeApproval): string {
  const handle = message.pendingRequest;
  return JSON.stringify([message.authority, message.approvalId, handle.requestId,
    handle.projectKey, handle.conversationId, handle.processId, handle.toolName]);
}

/** Prepare the rendered rail and its exact inline exclusions from one selection.
 * Current registry projections supply the facts; the merged conversation only
 * supplies stable row IDs for the same handle. This observes handles, grants none. */
export function createTeamApprovalPresentation(
  messages: readonly ChatMessage[],
  runId?: string,
  liveMessages?: readonly ChatMessage[],
): TeamApprovalPresentation {
  if (!runId) return { requests: [], hostedApprovals: [] };
  const mergedByHandle = new Map(messages.filter(isLiveCodeApproval)
    .map(message => [liveHandleKey(message), message]));
  const requests: ApprovalMessage[] = [];
  for (const message of liveMessages ?? messages) {
    if (!isLiveCodeApproval(message)
      || (message.requester !== undefined && message.requester.teamRunId !== runId)) continue;
    const merged = mergedByHandle.get(liveHandleKey(message));
    // A settled historical row cannot revoke a current registry request. Keep
    // that history read-only and retain the live rail entry under its own ID.
    requests.push(merged && merged.id !== message.id ? { ...message, id: merged.id } : message);
  }
  return { requests, hostedApprovals: requests.map(message => ({
    messageId: message.id, approvalId: message.approvalId, authority: 'code',
  })) };
}

/** Projects the owner's live requests; decisions still return to its registry. */
export function TeamApprovalRequests(props: {
  readonly presentation: TeamApprovalPresentation;
  readonly onRespond: NonNullable<import('../../../components/chat/ApprovalCard').ApprovalCardProps['onRespond']>;
  readonly onOpenPreview: (id: string) => void;
}): ReactElement {
  return <>{props.presentation.requests.map(message =>
    <ApprovalCard key={message.id} message={message} onRespond={props.onRespond} onOpenPreview={props.onOpenPreview} />)}</>;
}
