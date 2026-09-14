// Trylo Code's reasoning surface.
//
// The runtime emits thinking and tool events atomically. Those events are an
// excellent transport format, but they are not a readable document. This
// component projects a whole run segment into one continuous transcript while
// preserving every reasoning character and keeping tool calls in their real
// chronological position.

import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Check, ChevronRight, Hand, Loader, Wrench } from 'lucide-react';
import { ToolCard } from './ToolCard';
import { targetResultFactsOf, type TargetResultFacts } from '../../tooling/classifiers/windows-mcp-classifier';
import type { ThinkingMessage, ToolMessage } from './types';

export type CodeProcessEntry = ThinkingMessage | ToolMessage;

export interface CodeReasoningTranscriptProps {
  readonly entries: readonly CodeProcessEntry[];
  readonly active: boolean;
  readonly turnId: string;
  readonly phaseId: string;
}

const TOOL_VERBS: Readonly<Record<string, string>> = {
  read: '读取', grep: '查找', glob: '查找', edit: '修改', write: '写入',
  bash: '执行', task: '委派', webfetch: '读取网页', websearch: '搜索',
};

/** §11.3 用户接管 (WCC-P2-04): aggregate projection of the per-card takeover
 *  facts onto THIS run segment's header. The facts stay on the ToolCard
 *  (single source: the trylo-target block); the header only answers "did
 *  the user grab the desktop during this segment" — which is otherwise
 *  invisible while the transcript is collapsed. Derived per render from
 *  the same entries; no new event, no new store. */
const TAKEOVER_BADGE_LABELS: Readonly<Record<string, string>> = {
  safe_release: '用户接管 · 已安全释放',
  yielded: '控制权已交还用户',
  cancelled: '用户接管 · 操作已取消',
  verifying: '用户接管 · 只读验证后暂停',
};

const TAKEOVER_BADGE_ORDER: readonly string[] = ['safe_release', 'yielded', 'cancelled', 'verifying'];

// The active phase block legitimately re-renders on every thinking delta,
// and `takeoverBadgeLabel` then walks all of its entries again. Parsing the
// trylo-target JSON is O(output size), so cache per tool message — entries
// are immutable, so the cached fact stays valid for the object's lifetime.
const takeoverFactCache = new WeakMap<CodeProcessEntry, TargetResultFacts | null>();

function takeoverFactOf(entry: CodeProcessEntry): TargetResultFacts | null {
  if (entry.kind !== 'tool' || !entry.tool.startsWith('mcp__trylo-windows__')) return null;
  const cached = takeoverFactCache.get(entry);
  if (cached !== undefined) return cached;
  const fact = targetResultFactsOf(
    entry.outputContent ??
      (entry.outputText !== undefined ? [{ type: 'text', text: entry.outputText }] : undefined),
  );
  takeoverFactCache.set(entry, fact);
  return fact;
}

function takeoverBadgeLabel(entries: readonly CodeProcessEntry[]): string | null {
  let worst: string | null = null;
  let worstRank = TAKEOVER_BADGE_ORDER.length;
  for (const entry of entries) {
    const takeover = takeoverFactOf(entry)?.takeover;
    if (!takeover) continue;
    const rank = TAKEOVER_BADGE_ORDER.indexOf(takeover);
    if (rank >= 0 && rank < worstRank) {
      worstRank = rank;
      worst = takeover;
    }
  }
  return worst !== null ? (TAKEOVER_BADGE_LABELS[worst] ?? worst) : null;
}

function phaseTitle(entries: readonly CodeProcessEntry[], active: boolean): string {
  const tools = entries.filter((entry): entry is ToolMessage => entry.kind === 'tool');
  const running = [...tools].reverse().find((entry) => (
    entry.status === 'running' || entry.status === 'pending'
  ));
  if (running) {
    const verb = TOOL_VERBS[running.tool.toLowerCase()] ?? '运行';
    const target = running.summary.trim();
    const shortTarget = target.length > 46 ? `${target.slice(0, 45)}…` : target;
    return `正在${verb}${shortTarget ? ` · ${shortTarget}` : ''}`;
  }
  if (tools.some((entry) => entry.status === 'error')) return '操作需要处理';
  if (tools.length > 0) {
    if (active) return '正在推进任务';
    const last = tools.at(-1);
    if (last) {
      const verb = TOOL_VERBS[last.tool.toLowerCase()] ?? '操作';
      const target = last.summary.trim();
      const shortTarget = target.length > 54 ? `${target.slice(0, 53)}…` : target;
      return `${verb}完成${shortTarget ? ` · ${shortTarget}` : ''}`;
    }
  }
  if (active) return '正在分析';
  const latestThinking = [...entries].reverse().find(
    (entry): entry is ThinkingMessage => entry.kind === 'thinking',
  );
  const summary = latestThinking?.summary.trim() ?? '';
  return summary || '分析完成';
}

function CodeReasoningTranscriptImpl(
  props: CodeReasoningTranscriptProps,
): ReactElement {
  // A live run opens so the user can follow it. Historical runs start quiet,
  // but the complete transcript is always one click away and is never moved to
  // diagnostics or discarded.
  const [expanded, setExpanded] = useState(props.active);
  const [showCompletedTools, setShowCompletedTools] = useState(false);
  const wasActive = useRef(props.active);
  useEffect(() => {
    if (props.active) {
      wasActive.current = true;
      setExpanded(true);
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    // Let the completed state register briefly, then move the transcript out
    // of the way so the final answer and review result become the focal point.
    const timer = window.setTimeout(() => setExpanded(false), 420);
    return () => window.clearTimeout(timer);
  }, [props.active]);

  const thinkingCount = props.entries.filter((entry) => entry.kind === 'thinking').length;
  const toolCount = props.entries.length - thinkingCount;
  const title = useMemo(() => phaseTitle(props.entries, props.active), [props.active, props.entries]);
  const takeoverLabel = useMemo(() => takeoverBadgeLabel(props.entries), [props.entries]);
  const completedTools = props.entries.filter((entry): entry is ToolMessage => (
    entry.kind === 'tool' && (entry.status === 'done' || entry.status === 'interrupted')
  ));
  const visibleEntries = props.entries.filter((entry) => (
    entry.kind !== 'tool' || (entry.status !== 'done' && entry.status !== 'interrupted')
  ));

  let reasoningIndex = 0;
  return (
    <section
      className={`code-reasoning${props.active ? ' code-reasoning--active' : ''}${toolCount > 0 ? ' code-reasoning--tools' : ''}`}
      role="listitem"
      aria-label="Trylo Code 思考与行动"
      data-turn-id={props.turnId}
      data-phase-id={props.phaseId}
    >
      <button
        type="button"
        className="code-reasoning__head"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="code-reasoning__state" aria-hidden="true">
          {props.active
            ? <Loader size={14} strokeWidth={2.2} />
            : <Check size={14} strokeWidth={2.2} />}
        </span>
        <span className="code-reasoning__summary">{title}</span>
        {takeoverLabel !== null && (
          <span
            className="code-reasoning__takeover-badge"
            title={`${takeoverLabel} · 后续操作已转为逐次审批`}
          >
            <Hand size={12} strokeWidth={2.2} aria-hidden="true" />
            {takeoverLabel}
          </span>
        )}
        <span className="code-reasoning__meta">
          {thinkingCount > 0 ? `${thinkingCount} 段思考` : ''}
          {thinkingCount > 0 && toolCount > 0 ? ' · ' : ''}
          {toolCount > 0 ? `${toolCount} 次操作` : ''}
        </span>
        <ChevronRight
          size={15}
          strokeWidth={2.2}
          className={`disclosure-chevron${expanded ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        />
      </button>

      <div className={`disclosure${expanded ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
          <div className="code-reasoning__transcript" aria-label="完整思考过程">
            {visibleEntries.map((entry) => {
              if (entry.kind === 'tool') {
                return (
                  <div key={entry.id} className="code-reasoning__tool">
                    <ToolCard message={entry} />
                  </div>
                );
              }
              reasoningIndex += 1;
              const content = entry.preview.trim() || entry.summary.trim();
              if (content.length === 0) return null;
              return (
                <article key={entry.id} className="code-reasoning__passage">
                  <div className="code-reasoning__passage-label">
                    {entry.partial ? '当前思考' : `思考 ${reasoningIndex}`}
                  </div>
                  <div className="code-reasoning__passage-text">{content}</div>
                </article>
              );
            })}
            {completedTools.length > 0 && (
              <div className="code-reasoning__tool-group">
                <button
                  type="button"
                  className="code-reasoning__tool-summary"
                  onClick={() => setShowCompletedTools((value) => !value)}
                  aria-expanded={showCompletedTools}
                >
                  <Wrench size={13} strokeWidth={2} aria-hidden="true" />
                  <span>已运行 {completedTools.length} 次操作</span>
                  <ChevronRight
                    size={13}
                    className={`disclosure-chevron${showCompletedTools ? ' disclosure-chevron--open' : ''}`}
                    aria-hidden="true"
                  />
                </button>
                <div className={`disclosure${showCompletedTools ? ' disclosure--open' : ''}`}>
                  <div className="disclosure__inner">
                    <div className="code-reasoning__tool-list">
                      {completedTools.map((entry) => <ToolCard key={entry.id} message={entry} />)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export const CodeReasoningTranscript = memo(
  CodeReasoningTranscriptImpl,
  // MessageList's projection rebuilds every `__code_process` item — including
  // a fresh `entries` array — on each streaming delta, so default shallow
  // memoization never bails and every visible phase block re-rendered per
  // delta. Messages themselves are immutable (events.ts replaces changed
  // objects, never mutates), so same length + same element identities proves
  // identical content. A reorder of the same elements would be treated as
  // unchanged, but the projection appends in message order and messages are
  // append-only, so reorder cannot occur.
  function areTranscriptPropsEqual(a: CodeReasoningTranscriptProps, b: CodeReasoningTranscriptProps): boolean {
    if (a.active !== b.active || a.turnId !== b.turnId || a.phaseId !== b.phaseId) {
      return false;
    }
    if (a.entries === b.entries) return true;
    if (a.entries.length !== b.entries.length) return false;
    for (let i = 0; i < a.entries.length; i += 1) {
      if (a.entries[i] !== b.entries[i]) return false;
    }
    return true;
  },
);
CodeReasoningTranscript.displayName = 'CodeReasoningTranscript';
