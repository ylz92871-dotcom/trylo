import { InputRequestCard, type InputRequestCardProps } from './InputRequestCard'
import type { ChatMessage, InputRequestMessage } from './types'

/** Pending requests belong to the composer; resolution remains host-owned. */
export function ComposerInputRequests(props: {
  readonly messages: readonly ChatMessage[]
  readonly onRespond?: InputRequestCardProps['onRespond']
}): JSX.Element | null {
  const pending = props.messages.filter(
    (message): message is InputRequestMessage =>
      message.kind === 'input_request' && message.status === 'pending',
  )
  if (!pending.length) return null
  return (
    <section className="composer-input-requests" aria-label="待回答的问题">
      {pending.map((message) => (
        <InputRequestCard key={message.id} message={message} onRespond={props.onRespond} />
      ))}
    </section>
  )
}
