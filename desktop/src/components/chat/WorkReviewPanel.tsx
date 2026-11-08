import type { ReactElement } from 'react';
import { WorkResultContent, latestRunArtifactCount, type WorkResultContentProps } from './WorkResultContent';

export type WorkReviewPanelProps = Omit<WorkResultContentProps, 'presentation'>;

/** Presents the existing delivery snapshot in the shared results rail. */
export function WorkReviewPanel(props: WorkReviewPanelProps): ReactElement {
  const { result } = props;
  const count = latestRunArtifactCount(result);

  return <div className="code-review work-review">
    <div className="code-review__overview">
      <span>交付记录</span>
      <span>{count} 个本轮交付物</span>
    </div>
    <p className="code-review__hint">选择文件预览，或使用更多操作。</p>
    {result.latestRun?.warning && <p className="code-review__warning" role="status">
      {result.latestRun.warning}
    </p>}
    {result.truncated && <p className="code-review__hint" role="status">
      交付记录较多，当前仅显示已保留的文件。
    </p>}
    <WorkResultContent {...props} presentation="review" />
  </div>;
}
