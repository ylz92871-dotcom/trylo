import { type ReactElement, useState } from 'react';
import type { LearningReceipt } from '../../user-learning/types';

export interface LearningReceiptPopoverProps {
  readonly receipt: LearningReceipt;
  readonly canActivate: boolean;
  readonly onActivate: () => void;
  readonly onThisTimeOnly: () => void;
  readonly onChangeScope: (scope: 'project' | 'product') => void;
  readonly onPause: () => void;
  readonly onRetract: () => void;
}

export function LearningReceiptPopover(props: LearningReceiptPopoverProps): ReactElement {
  const [choosingScope, setChoosingScope] = useState(false);
  return (
    <div className="learning-receipt-popover" role="dialog" aria-label="学习回执详情">
      <p className="learning-receipt-popover__message">{props.receipt.message}</p>
      <dl className="learning-receipt-popover__details">
        <div><dt>来源</dt><dd>{props.receipt.sourceSummary}</dd></div>
        <div><dt>范围</dt><dd>{props.receipt.scopeLabel}</dd></div>
        <div><dt>生效</dt><dd>{new Date(props.receipt.effectiveFrom).toLocaleString()}</dd></div>
      </dl>
      {choosingScope ? (
        <div className="learning-receipt-popover__scope" aria-label="修改适用范围">
          <button type="button" onClick={() => props.onChangeScope('project')}>仅当前项目</button>
          <button type="button" onClick={() => props.onChangeScope('product')}>此产品通用</button>
        </div>
      ) : null}
      <footer className="learning-receipt-popover__actions">
        {props.canActivate ? (
          <button type="button" className="learning-receipt-popover__primary" onClick={props.onActivate}>以后这样做</button>
        ) : null}
        <button type="button" onClick={props.onThisTimeOnly}>仅本次</button>
        <button type="button" onClick={() => setChoosingScope((value) => !value)}>修改范围</button>
        <button type="button" onClick={props.onPause}>暂停</button>
        <button type="button" className="learning-receipt-popover__danger" onClick={props.onRetract}>撤回</button>
      </footer>
    </div>
  );
}
