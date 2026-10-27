import type { ReactElement } from 'react';
import { ApprovalCard } from '../../../components/chat/ApprovalCard';
import type { ChatMessage } from '../../../components/chat/types';

/** Projects the owner's live requests; decisions still return to its registry. */
export function TeamApprovalRequests(props: {
  readonly runId: string;
  readonly messages: readonly ChatMessage[];
  readonly onRespond: (id: string, approved: boolean) => void;
  readonly onOpenPreview: (id: string) => void;
}): ReactElement {
  return <>{props.messages.map(message => message.kind === 'approval'
    && (message.requester === undefined || message.requester.teamRunId === props.runId)
    ? <ApprovalCard key={message.id} message={message} onRespond={props.onRespond} onOpenPreview={props.onOpenPreview} />
    : null)}</>;
}
