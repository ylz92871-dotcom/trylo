// Trylo Desktop — OfficeWorkflowPanel
//
// Thin wrapper around deliverable logic for OfficeCLI (docx/xlsx/pptx).
// Reuses DeliverableProgressPanel's visual language + AutoNotice for
// dont_ask non-blocking reminders. No modal, no extra spinner.

import { memo, type ReactElement } from 'react';
import { AutoNotice } from './AutoNotice';

export interface OfficeWorkflowPanelProps {
  readonly fileName?: string;
  readonly kind: 'document' | 'spreadsheet' | 'presentation';
  readonly status: 'running' | 'done';
  /** e.g. ".trylo/out/report.docx" */
  readonly outPath?: string;
  /** dont_ask auto mode: show non-blocking reminder instead of blocking */
  readonly autoMode?: boolean;
}

function labelFor(kind: OfficeWorkflowPanelProps['kind']): string {
  switch (kind) {
    case 'document': return '文档';
    case 'spreadsheet': return '表格';
    case 'presentation': return '演示文稿';
  }
}

function OfficeWorkflowPanelImpl(props: OfficeWorkflowPanelProps): ReactElement {
  const running = props.status === 'running';
  return (
    <div className="work-activities" role="listitem" aria-label={`Office · ${labelFor(props.kind)}`}>
      <div className="work-activities__head" style={{ cursor: 'default' } as React.CSSProperties}>
        <span className="work-activities__head-summary">
          {running ? `正在生成${labelFor(props.kind)}` : `已生成${labelFor(props.kind)}`}
          {props.fileName ? ` · ${props.fileName}` : ''}
        </span>
      </div>
      {props.outPath ? (
        props.autoMode ? (
          <AutoNotice
            id={`office:${props.outPath}`}
            tone="info"
            title={`已写入 ${props.outPath}`}
            detail="原件不受影响 · 已复制到 .trylo/out/"
            autoContinueMs={3000}
          />
        ) : (
          <div className="auto-notice auto-notice--info">
            <span className="auto-notice__title">已写入 {props.outPath}</span>
            <span className="auto-notice__detail">原件不受影响</span>
          </div>
        )
      ) : null}
    </div>
  );
}

export const OfficeWorkflowPanel = memo(OfficeWorkflowPanelImpl);
