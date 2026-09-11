// Trylo Code's reasoning surface.
//
// The runtime emits thinking and tool events atomically. Those events are an
// excellent transport format, but they are not a readable document. This
// component projects a whole run segment into one continuous transcript while
// preserving every reasoning character and keeping tool calls in their real
// chronological position.

import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Check, ChevronRight, Loader, Wrench } from 'lucide-react';
import { ToolCard } from './ToolCard';
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

export const CodeReasoningTranscript = memo(CodeReasoningTranscriptImpl);
CodeReasoningTranscript.displayName = 'CodeReasoningTranscript';
