import type { ReactElement } from 'react';
import { ArrowRight, ChevronDown, CircleAlert } from 'lucide-react';
import type { CompactionMessage } from './types';

export type CompactionNoticePresentation =
  | { readonly state: 'running' }
  | { readonly state: 'failed'; readonly detail: string };

export type CompactionCardProps = { readonly message: CompactionMessage } | CompactionNoticePresentation;

/** Project existing notice vocabulary without changing stored messages or runtime flags. */
export function compactionNoticePresentation(text: string): CompactionNoticePresentation | null {
  if (text.startsWith('Compacting context')) return { state: 'running' };
  const failurePrefix = '上下文压缩未完成：';
  return text.startsWith(failurePrefix) ? { state: 'failed', detail: text.slice(failurePrefix.length) } : null;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function hasCount(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function FoldMark(): ReactElement {
  return <svg className="compaction__icon" width="18" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path className="compaction__fold-top" d="M5 3h10M7 6l3 3 3-3" />
    <path className="compaction__fold-bottom" d="M5 17h10M7 14l3-3 3 3" />
  </svg>;
}

/** One timeline treatment for pending, committed and failed compactions. */
export function CompactionCard(props: CompactionCardProps): ReactElement {
  const message = 'message' in props ? props.message : null;
  const state = 'state' in props ? props.state : 'done';
  const detail = 'detail' in props ? props.detail : '';
  const beforeTokens = message?.tokensBefore;
  const afterTokens = message?.tokensAfter;
  const hasBefore = hasCount(beforeTokens);
  const hasAfter = hasCount(afterTokens);
  const before = hasBefore ? formatTokens(beforeTokens) : '—';
  const after = hasAfter ? formatTokens(afterTokens) : '—';
  const hasAny = hasBefore || hasAfter;
  const change = hasBefore && hasAfter ? beforeTokens - afterTokens : null;
  const usageDetail = [
    `压缩前：${hasBefore ? `${beforeTokens.toLocaleString('en-US')} tokens` : '未提供'}`,
    `压缩后：${hasAfter ? `${afterTokens.toLocaleString('en-US')} tokens` : '未提供'}`,
    ...(change === null ? [] : [`${change >= 0 ? '减少' : '增加'}：${Math.abs(change).toLocaleString('en-US')} tokens`]),
  ].join('；');
  const title = state === 'running' ? '正在压缩上下文' : state === 'failed' ? '上下文压缩未完成' : '上下文已压缩';
  const heading = <>
    {state === 'failed' ? <CircleAlert className="compaction__icon" size={18} strokeWidth={1.5} aria-hidden="true" /> : <FoldMark />}
    <span className="compaction__title" role="status" aria-atomic="true">{title}</span>
    {hasAny && <span className="compaction__usage" aria-label={`压缩前：${before} tokens；压缩后：${after} tokens`} title={usageDetail}>
      <span>压缩前 {before}</span><ArrowRight size={12} strokeWidth={1.5} aria-hidden="true" /><span>压缩后 {after}</span><span className="compaction__unit">tokens</span>
    </span>}
    <span className="compaction__rule" aria-hidden="true" />
  </>;
  return <div className="compaction" data-state={state} role="listitem">
    {state === 'failed' && detail.trim() ? <details className="compaction__failure">
      <summary className="compaction__heading">{heading}<span className="compaction__disclosure">查看原因<ChevronDown size={13} aria-hidden="true" /></span></summary>
      <pre className="compaction__diagnostic">{detail}</pre>
    </details> : <div className="compaction__heading">{heading}</div>}
  </div>;
}
