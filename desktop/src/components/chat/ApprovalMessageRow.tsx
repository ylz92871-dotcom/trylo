import { useContext, type ReactElement } from 'react';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard';
import { ConversationPresentation, isHostedApproval, isLiveCodeApproval } from './ConversationPresentation';

/** Only approval rows subscribe to host placement; memoized text/tool rows
 * must not re-render whenever the surrounding conversation layout changes. */
export function ApprovalMessageRow(props: Pick<ApprovalCardProps, 'message' | 'onRespond' | 'onOpenPreview'>): ReactElement {
  const { hostedApprovals } = useContext(ConversationPresentation);
  const m = props.message;
  if (isHostedApproval(m, hostedApprovals)) return <></>;
  const live = isLiveCodeApproval(m);
  const presented = m.authority === 'code' && m.status === 'pending' && !live
    ? { ...m, status: 'expired' as const } : m;
  return (
    <div className="message message--approval" role="listitem">
      <ApprovalCard key={m.id} message={presented}
        onRespond={live ? props.onRespond : undefined} onOpenPreview={props.onOpenPreview} />
    </div>
  );
}
