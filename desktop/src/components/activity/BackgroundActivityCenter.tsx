import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, PanelsTopLeft, Code2, Layers2, LoaderCircle, Square, X } from 'lucide-react';
import { useActivityPosition } from './use-activity-position';

export type ActivityKind = 'code' | 'work' | 'unknown';
export interface ActivityItem {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly conversationId: string;
  readonly workspaceLabel: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly startedAt: number;
  readonly onStop: () => void | Promise<void>;
  readonly onJump?: () => void;
}
export interface BackgroundActivityCenterProps {
  readonly id?: string;
  readonly open: boolean;
  readonly items: readonly ActivityItem[];
  readonly anchor?: HTMLElement | null;
  readonly onClose: () => void;
}

const labels: Readonly<Record<string, string>> = {
  'Starting…': '正在启动', Starting: '正在启动', Ready: '准备就绪', Running: '执行中',
  Working: '执行中', Reconnecting: '正在重连', Idle: '等待下一步', Exited: '已退出',
};
function elapsed(startedAt: number, now: number): string {
  if (!Number.isFinite(startedAt)) return '耗时未知';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分`;
}

export function BackgroundActivityCenter(props: BackgroundActivityCenterProps): ReactElement | null {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  const anchor = useRef(props.anchor);
  const mounted = useRef(true);
  close.current = props.onClose;
  anchor.current = props.anchor;
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const hasItems = props.items.length > 0;
  useActivityPosition(panel, props.open, props.anchor);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!props.open || !hasItems) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.open, hasItems]);
  useEffect(() => {
    if (!props.open) return;
    const root = panel.current;
    const previous = anchor.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    root?.querySelector<HTMLButtonElement>('[data-activity-close]')?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close.current(); }
    };
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root?.contains(event.target) && !anchor.current?.contains(event.target)) close.current();
    };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
      if (previous?.isConnected && (root?.contains(document.activeElement) || document.activeElement === document.body)) previous.focus();
    };
  }, [props.open]);

  const stop = async (item: ActivityItem): Promise<void> => {
    if (pending.has(item.id)) return;
    setPending(current => new Set(current).add(item.id));
    setErrors(current => ({ ...current, [item.id]: '' }));
    try { await item.onStop(); }
    catch (error) {
      if (mounted.current) setErrors(current => ({ ...current, [item.id]: error instanceof Error ? error.message : '停止失败，请重试。' }));
    } finally {
      if (mounted.current) setPending(current => { const next = new Set(current); next.delete(item.id); return next; });
    }
  };
  if (!props.open) return null;
  return createPortal(<div ref={panel} id={id} className="activity-center" role="dialog" aria-label="运行中的任务">
    <header className="activity-center__header">
      <div><h2>运行中的任务{hasItems && <span className="activity-center__count" aria-label={`${props.items.length}项任务`}>{props.items.length}</span>}</h2><p>查看进展，随时返回会话</p></div>
      <button type="button" className="activity-center__close" onClick={props.onClose} aria-label="关闭任务面板" title="关闭" data-activity-close><X size={16} strokeWidth={1.6} /></button>
    </header>
    {!hasItems ? <div className="activity-center__empty"><span className="activity-center__empty-icon" aria-hidden="true"><Layers2 size={21} strokeWidth={1.4} /></span><strong>当前没有运行中的任务</strong><p>开始任务后，可在这里返回会话或停止执行。</p></div>
      : <ul className="activity-center__list" aria-label="运行任务列表">{props.items.map(item => {
        const Icon = item.kind === 'work' ? PanelsTopLeft : item.kind === 'code' ? Code2 : Layers2;
        const busy = pending.has(item.id);
        return <li key={item.id} className="activity-row">
          <button type="button" className="activity-row__open" disabled={!item.onJump} onClick={() => { item.onJump?.(); props.onClose(); }} aria-label={`返回会话：${item.title}`} title={item.onJump ? item.title : '会话信息暂不可用，可停止执行'}>
            <span className="activity-row__kind" aria-hidden="true"><Icon size={16} strokeWidth={1.5} /></span>
            <span className="activity-row__body"><span className="activity-row__title">{item.title}</span>
              <span className="activity-row__meta"><span title={item.workspaceLabel}>{item.workspaceLabel}</span><span aria-hidden="true">·</span><span>{item.kind === 'work' ? 'Work' : item.kind === 'code' ? 'Code' : '会话'}</span></span>
              <span className="activity-row__state"><span>{labels[item.statusLabel] ?? item.statusLabel}</span><span aria-hidden="true">·</span><time>{elapsed(item.startedAt, now)}</time></span>
            </span><ArrowUpRight className="activity-row__arrow" size={13} aria-hidden="true" />
          </button>
          <button type="button" className="activity-row__stop" disabled={busy} onClick={() => void stop(item)} aria-label={`${busy ? '正在停止' : '停止任务'}：${item.title}`} title={busy ? '正在停止' : '停止任务'}>
            {busy ? <LoaderCircle className="activity-center__spinner" size={15} aria-hidden="true" /> : <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" />}
          </button>
          {errors[item.id] && <p className="activity-row__error" role="alert">{errors[item.id]}</p>}
        </li>;
      })}</ul>}
  </div>, document.body);
}
