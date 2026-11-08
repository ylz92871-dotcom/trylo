// Trylo Desktop — SubagentCard (P3 §8.1 + audit §4.4 B3).
//
// Current CLI tasks and retired CoWork records share a read-only summary card.
// Historical managed session identifiers are retained for evidence and artifacts;
// they never expose a connection, continuation or cancellation action.

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { SubagentMessage } from './types';
import { isRetiredManagedWork } from './retired-work';

const STATUS_LABEL: Record<SubagentMessage['status'], string> = {
  running: '运行中',
  done: '已完成',
  waiting: '等待中',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_COLOR: Record<SubagentMessage['status'], string> = {
  running: 'var(--ice-blue)',
  done: 'var(--brand)',
  waiting: 'var(--brand)',
  failed: 'var(--danger)',
  cancelled: 'var(--ink-fog)',
};

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--ink-hover)',
  background: 'var(--ink-surface)',
  fontSize: 13,
  color: 'var(--ink-paper)',
  maxWidth: 560,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const badgeStyle = (color: string): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: 4,
  background: color,
  flexShrink: 0,
});

const dimStyle: CSSProperties = { color: 'var(--ink-fog)', lineHeight: 1.45, wordBreak: 'break-word' };

const detailStyle: CSSProperties = {
  marginTop: 4,
  paddingTop: 8,
  borderTop: '1px dashed var(--ink-hover)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  color: 'var(--ink-fog)',
  fontSize: 12,
};

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <span style={{ color: 'var(--ink-mute)' }}>{label}: </span>
      <span style={{ wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

export interface SubagentCardProps {
  readonly message: SubagentMessage;

}

export function SubagentCard({ message }: SubagentCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const isManaged = isRetiredManagedWork(message);

  return (
    <div style={cardStyle} role="listitem">
      <div style={rowStyle}>
        <span style={badgeStyle(isManaged ? 'var(--ink-fog)' : STATUS_COLOR[message.status])} aria-hidden="true" />
        <span style={{ fontWeight: 600 }}>{message.agentType}</span>
        <span style={{ color: isManaged ? 'var(--ink-fog)' : STATUS_COLOR[message.status] }}>{isManaged ? '历史任务' : STATUS_LABEL[message.status]}</span>
        {message.managedSessionId ? (
          <span style={{ color: 'var(--ink-mute)' }}>#{message.managedSessionId.slice(0, 8)}</span>
        ) : null}
      </div>

      {message.prompt ? <div style={dimStyle}>{truncate(message.prompt, 180)}</div> : null}
      {message.result && !expanded ? <div style={dimStyle}>{truncate(message.result, 220)}</div> : null}

      {isManaged ? <div style={dimStyle}>CoWork 执行器已退役，历史答复与交付物仍可查看。</div> : null}

      {(message.managedSessionId || message.summary || message.artifacts?.length || typeof message.durationMs === 'number') ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            alignSelf: 'flex-start',
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--ice-blue)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {expanded ? '收起详情' : '查看交付物 / 详情'}
        </button>
      ) : null}

      {expanded ? (
        <div style={detailStyle}>
          {message.managedSessionId ? <DetailRow label="Session" value={message.managedSessionId} /> : null}
          {message.backingTaskId ? <DetailRow label="Backing task" value={message.backingTaskId} /> : null}
          {message.summary ? <DetailRow label="摘要" value={message.summary} /> : null}
          {message.artifacts && message.artifacts.length > 0 ? (
            <div>
              <span style={{ color: 'var(--ink-mute)' }}>产物: </span>
              <ul style={{ margin: '2px 0 0 14px', padding: 0 }}>
                {message.artifacts.map((a) => (
                  <li key={a} style={{ wordBreak: 'break-all' }}>{a}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {typeof message.durationMs === 'number' ? (
            <DetailRow label="耗时" value={`${Math.round(message.durationMs / 1000)}s`} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
