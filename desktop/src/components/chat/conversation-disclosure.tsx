import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';

type Choices = Map<string, Map<string, boolean>>;
const DisclosureContext = createContext<Choices | null>(null);

/** Reader choices belong to the conversation, since virtual rows are disposable.
 * Only manual choices are cached; live/error defaults still follow event status. */
export function ConversationDisclosureProvider(props: {
  readonly messages: readonly { readonly id: string }[];
  readonly children: ReactNode;
}): JSX.Element {
  const choices = useRef<Choices>(new Map()).current;
  useEffect(() => {
    if (choices.size === 0) return;
    const ids = new Set(props.messages.map(message => message.id));
    for (const id of choices.keys()) if (!ids.has(id)) choices.delete(id);
  }, [choices, props.messages]);
  return <DisclosureContext.Provider value={choices}>{props.children}</DisclosureContext.Provider>;
}

export function useConversationDisclosure(messageId: string, scope: string): readonly [boolean | null, (open: boolean) => void] {
  const shared = useContext(DisclosureContext);
  const local = useRef<Choices>(new Map()).current;
  const choices = shared ?? local;
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const setOpen = useCallback((open: boolean): void => {
    let entry = choices.get(messageId);
    if (!entry) { entry = new Map(); choices.set(messageId, entry); }
    entry.set(scope, open);
    refresh();
  }, [choices, messageId, scope]);
  return [choices.get(messageId)?.get(scope) ?? null, setOpen];
}
