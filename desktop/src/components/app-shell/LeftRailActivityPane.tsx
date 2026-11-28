import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowUpRight, Code2, Layers2, LoaderCircle, PanelsTopLeft, Square, SquarePen } from 'lucide-react';
import type { ActivityItem } from '../activity/BackgroundActivityCenter';

export interface LeftRailActivityPaneProps {
  readonly items: readonly ActivityItem[];
  readonly onSelectItem?: () => void;
  readonly onNewSession?: () => void;
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  'Starting…': '正在启动',
  Starting: '正在启动',
  Ready: '准备就绪',
  Running: '执行中',
  Working: '执行中',
  Reconnecting: '正在重连',
  Idle: '等待下一步',
  Exited: '已退出',
};

function formatElapsed(startedAt: number, now: number): string {
  if (!Number.isFinite(startedAt)) return '耗时未知';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分`;
}

export function LeftRailActivityPane(props: LeftRailActivityPaneProps): ReactElement {
  const mounted = useRef(true);
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const hasItems = props.items.length > 0;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hasItems) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasItems]);

  const stop = async (item: ActivityItem): Promise<void> => {
    if (pending.has(item.id)) return;
    setPending((current) => new Set(current).add(item.id));
    setErrors((current) => ({ ...current, [item.id]: '' }));
    try {
      await item.onStop();
    } catch (error) {
      if (mounted.current) {
        setErrors((current) => ({
          ...current,
          [item.id]: error instanceof Error ? error.message : '停止失败，请重试。',
        }));
      }
    } finally {
      if (mounted.current) {
        setPending((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    }
  };

  return (
    <>
      <div className="left-rail__pane-header">
        <span className="left-rail__pane-title">运行中的任务</span>
        {hasItems && (
          <span className="left-rail__pane-badge" aria-label={`${props.items.length}项任务`}>
            {props.items.length}
          </span>
        )}
      </div>

      <div className="left-rail__pane-body">
        {!hasItems ? (
          <div className="left-rail__pane-empty">
            <span className="left-rail__pane-empty-icon" aria-hidden="true">
              <Layers2 size={20} strokeWidth={1.5} />
            </span>
            <strong>当前没有运行中的任务</strong>
            <p>开始任务后，可在这里查看进展、返回会话或停止执行。</p>
            {props.onNewSession && (
              <button type="button" className="left-rail__pane-empty-action" onClick={props.onNewSession}>
                <SquarePen size={13} aria-hidden="true" />
                <span>新任务</span>
              </button>
            )}
          </div>
        ) : (
          <ul className="left-rail__activity-list" aria-label="运行任务列表">
            {props.items.map((item) => {
              const Icon = item.kind === 'work' ? PanelsTopLeft : item.kind === 'code' ? Code2 : Layers2;
              const busy = pending.has(item.id);
              return (
                <li key={item.id} className="left-rail__activity-item">
                  <button
                    type="button"
                    className="left-rail__activity-open"
                    disabled={!item.onJump}
                    onClick={() => {
                      item.onJump?.();
                      props.onSelectItem?.();
                    }}
                    aria-label={`返回会话：${item.title}`}
                    title={item.onJump ? item.title : '会话信息暂不可用，可停止执行'}
                  >
                    <span className="left-rail__activity-icon" aria-hidden="true">
                      <Icon size={14} strokeWidth={1.65} />
                    </span>
                    <span className="left-rail__activity-body">
                      <span className="left-rail__activity-title">{item.title}</span>
                      <span className="left-rail__activity-meta">
                        <span title={item.workspaceLabel}>{item.workspaceLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.kind === 'work' ? 'Work' : item.kind === 'code' ? 'Code' : '会话'}</span>
                      </span>
                      <span className="left-rail__activity-state">
                        <span>{STATUS_LABELS[item.statusLabel] ?? item.statusLabel}</span>
                        <span aria-hidden="true">·</span>
                        <time>{formatElapsed(item.startedAt, now)}</time>
                      </span>
                    </span>
                    <ArrowUpRight className="left-rail__activity-arrow" size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="left-rail__activity-stop"
                    disabled={busy}
                    onClick={() => void stop(item)}
                    aria-label={`${busy ? '正在停止' : '停止任务'}：${item.title}`}
                    title={busy ? '正在停止' : '停止任务'}
                  >
                    {busy ? (
                      <LoaderCircle className="left-rail__activity-spinner" size={14} aria-hidden="true" />
                    ) : (
                      <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                    )}
                  </button>
                  {errors[item.id] && (
                    <p className="left-rail__activity-error" role="alert">
                      {errors[item.id]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
