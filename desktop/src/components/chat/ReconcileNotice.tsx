import type { ReactElement } from 'react';
import { EffectReconcileCard } from './EffectReconcileCard';
import { RuntimeNotice } from './RuntimeNotice';
import { useEffectReconcileHost } from './effect-reconcile-context';
import type { NoticeMessage } from './types';

/**
 * 一条 system notice 的两种身份。
 *
 * 普通提示还是"要你回答的问题"，只差一个字段：`reconcile`。有这个字段时，
 * 光把英文错误念一遍是不负责任的——会话就卡在这一步，而唯一的出路在界面里。
 */
export function ReconcileNotice(props: {
  readonly message: NoticeMessage;
  readonly onSettled?: (input: { readonly key: string; readonly turn: string }) => void;
}): ReactElement {
  const host = useEffectReconcileHost();
  const pending = props.message.reconcile;

  if (pending === undefined) return <RuntimeNotice text={props.message.text} />;

  return (
    <EffectReconcileCard
      pending={pending.pending}
      onSettle={async (input) => {
        const result = await host.settle({ ...input, sessionId: pending.sessionId });
        if (result.ok) props.onSettled?.({ key: input.key, turn: input.turn });
        return result;
      }}
    />
  );
}
