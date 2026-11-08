import type { ReactElement } from 'react';
import type { StoredCodeRunResult } from '../../results/conversation-result-types';
import { CodeResultContent } from './CodeResultContent';

export interface CodeReviewPanelProps {
  readonly result: StoredCodeRunResult;
  readonly currentTurn?: boolean;
  readonly onOpenDiff: (path: string, oldPath?: string) => void;
  readonly onOpenFile: (path: string) => void;
}

/** Uses the recorded result; opening a row delegates to the existing preview tab. */
export function CodeReviewPanel(props: CodeReviewPanelProps): ReactElement {
  const { result } = props;
  const historical = result.attribution === 'run_delta' && props.currentTurn === false;
  const hasStats = result.statsComplete === true
    && result.additionsTotal !== undefined && result.deletionsTotal !== undefined;
  const passed = result.checks.filter(check => check.status === 'passed').length;
  const failed = result.checks.filter(check => check.status === 'failed').length;
  return (
    <div className="code-review">
      <div className="code-review__overview">
        <span>{result.attribution === 'run_delta'
          ? historical ? '上轮记录' : '本轮记录'
          : '工作区记录'}</span>
        {hasStats && <span className="code-review__stats" aria-label="Git HEAD 到工作区的增删行数">
          <span className="code-result__plus">+{result.additionsTotal}</span>
          <span className="code-result__minus">−{result.deletionsTotal}</span>
        </span>}
      </div>
      <p className="code-review__hint">选择文件查看差异 · 对比 Git HEAD 与当前工作区</p>
      {result.checkCountTotal > 0 && <p className="code-review__checks-summary">
        {passed} 项检查通过{failed > 0 ? ` · ${failed} 项失败` : ''}
        {result.checks.length < result.checkCountTotal ? ' · 记录不完整' : ''}
      </p>}
      {result.meta.warning && <p className="code-review__warning" role="status">{result.meta.warning}</p>}
      {result.truncated && <p className="code-review__hint" role="status">变更记录较多，当前仅显示已保留的文件。</p>}
      <CodeResultContent result={result} historical={historical}
        onOpenDiff={props.onOpenDiff} onOpenFile={props.onOpenFile} />
    </div>
  );
}
