// Trylo Desktop — SubagentCard (P3 §8.1 + audit §4.4 B3).
//
// Renders a `subagent` ChatMessage (the CLI's subagent spawn/end lifecycle,
// plus the managed-work fields). A compact card with a status badge, the
// agent type, the delegate prompt, and — for managed-work — a "在后台继续"
// hint when the durable session is still active. An expandable detail section
// shows the managed session id, backing task id, summary and artifacts.
//
// P3-B3: for an active managed-work session the card exposes "继续" (targets
// the SAME managedSessionId via an inline follow-up input) and "取消"
// (managedSession.cancel) — routed through `onManagedWorkAction`. Closing the
// parent conversation never auto-cancels; only this explicit button does.
//
// Styling uses the design-token custom properties only (no new colors).

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { SubagentMessage } from './types';

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

const actionBtnStyle: CSSProperties = {
  background: 'none',
  border: '1px solid var(--ink-hover)',
  borderRadius: 6,
  padding: '3px 10px',
  color: 'var(--ink-paper)',
  fontSize: 12,
  cursor: 'pointer',
};

const primaryBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  borderColor: 'var(--brand)',
  color: 'var(--brand)',
};

const dangerBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  borderColor: 'var(--danger)',
  color: 'var(--danger)',
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
  /** P3-B3: continue (targets the SAME managedSessionId) / cancel. */
  readonly onManagedWorkAction?: (sessionId: string, action: 'continue' | 'cancel', text?: string) => void;
}

export function SubagentCard({ message, onManagedWorkAction }: SubagentCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const terminal =
    message.status === 'done' || message.status === 'failed' || message.status === 'cancelled';
  const isManaged = Boolean(message.managedSessionId);

  const submitContinue = (): void => {
    const text = followUp.trim();
    if (!text || !message.managedSessionId) return;
    setContinuing(false);
    setFollowUp('');
    onManagedWorkAction?.(message.managedSessionId, 'continue', text);
  };

  const cancel = (): void => {
    if (!message.managedSessionId || cancelling) return;
    setCancelling(true);
    onManagedWorkAction?.(message.managedSessionId, 'cancel');
  };

  return (
    <div style={cardStyle} role="listitem">
      <div style={rowStyle}>
        <span style={badgeStyle(STATUS_COLOR[message.status])} aria-hidden="true" />
        <span style={{ fontWeight: 600 }}>{message.agentType}</span>
        <span style={{ color: STATUS_COLOR[message.status] }}>{STATUS_LABEL[message.status]}</span>
        {message.managedSessionId ? (
          <span style={{ color: 'var(--ink-mute)' }}>#{message.managedSessionId.slice(0, 8)}</span>
        ) : null}
      </div>

      {message.prompt ? <div style={dimStyle}>{truncate(message.prompt, 180)}</div> : null}
      {message.result && !expanded ? <div style={dimStyle}>{truncate(message.result, 220)}</div> : null}

      {isManaged && !terminal ? (
        <div style={{ color: 'var(--brand)', fontSize: 12 }}>在后台继续 · 可稍后查看结果</div>
      ) : null}

      {/* P3-B3: continue / cancel for an active managed-work session. */}
      {isManaged && !terminal && onManagedWorkAction ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          {continuing ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
              <input
                type="text"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitContinue();
                }}
                placeholder="输入后续指令并回车…"
                autoFocus
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: 'var(--ink-hover)',
                  border: '1px solid var(--ink-mute)',
                  borderRadius: 6,
                  padding: '4px 8px',
                  color: 'var(--ink-paper)',
                  fontSize: 12,
                }}
              />
              <button type="button" style={primaryBtnStyle} onClick={submitContinue}>
                发送
              </button>
              <button type="button" style={actionBtnStyle} onClick={() => setContinuing(false)}>
                取消
              </button>
            </div>
          ) : (
            <>
              <button type="button" style={primaryBtnStyle} onClick={() => setContinuing(true)}>
                继续
              </button>
              <button type="button" style={dangerBtnStyle} onClick={cancel} disabled={cancelling}>
                {cancelling ? '取消中…' : '取消'}
              </button>
            </>
          )}
        </div>
      ) : null}

      {(message.managedSessionId || message.summary || message.artifacts?.length || message.durationMs != null) ? (
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
          {message.durationMs != null ? (
            <DetailRow label="耗时" value={`${Math.round(message.durationMs / 1000)}s`} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
