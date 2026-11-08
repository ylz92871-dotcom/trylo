// Trylo Code's reasoning surface.
//
// The runtime emits thinking and tool events atomically. Those events are an
// excellent transport format, but they are not a readable document. This
// component projects a whole run segment into one continuous transcript while
// preserving every reasoning character and keeping tool calls in their real
// chronological position.

import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AlertCircle, Ban, ChevronRight, Clock3, FileEdit, FileText, Globe, Hand, Keyboard, Loader, MousePointer2, ScanEye, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react';
import { ToolCard } from './ToolCard';
import { useConversationDisclosure } from './conversation-disclosure';
import { FileChangeCards } from './FileChangeCard';
import { EventReasoningNote } from './EventReasoningNote';
import { toolEventVerb } from './tool-event-presentation';
import { computeFileChanges } from './file-change';
import { targetResultFactsOf, type TargetResultFacts } from '../../tooling/classifiers/windows-mcp-classifier';
import type { ThinkingMessage, ToolMessage } from './types';

export type CodeProcessEntry = ThinkingMessage | ToolMessage;

export interface CodeReasoningTranscriptProps {
  readonly entries: readonly CodeProcessEntry[];
  readonly active: boolean;
  readonly turnId: string;
  readonly phaseId: string;
  readonly workspacePath?: string;
  readonly onOpenArtifact?: (path: string) => void;
}

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

function compactPhaseLabel(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const PHASE_TOOL_ICONS: Readonly<Record<string, LucideIcon>> = {
  read: FileText, read_file: FileText, readfile: FileText,
  grep: Search, glob: Search, search: Search, list: Search,
  edit: FileEdit, edit_file: FileEdit, apply_patch: FileEdit, applypatch: FileEdit, multiedit: FileEdit, write: FileEdit, write_file: FileEdit,
  notebookedit: FileEdit, notebook_edit: FileEdit,
  bash: Terminal, shell: Terminal, exec: Terminal, execute: Terminal,
  webfetch: Globe, websearch: Globe, fetch: Globe, navigate: Globe,
  wait: Clock3, snapshot: ScanEye, screenshot: ScanEye,
  click: MousePointer2, doubleclick: MousePointer2, drag: MousePointer2,
  type: Keyboard, type_text: Keyboard, presskey: Keyboard,
};

function phaseToolIcon(tool: ToolMessage | undefined): LucideIcon {
  const name = tool?.tool.split('__').at(-1)?.toLowerCase() ?? '';
  return PHASE_TOOL_ICONS[name] ?? (tool?.tool.toLowerCase().includes('browser') ? Globe : Wrench);
}

function phaseToolLabel(tool: ToolMessage, running: boolean): string {
  const description = tool.input?.['description'];
  if (typeof description === 'string' && description.trim() && !/^\s*(?:\{|\[)/.test(description)) {
    return `${running ? '正在' : '操作结束 · '}${compactPhaseLabel(description)}`;
  }
  const name = tool.tool.split('__').at(-1)?.toLowerCase() ?? '';
  if (name === 'wait') return running ? '正在等待' : '等待结束';
  if (name === 'snapshot') return running ? '正在查看窗口' : '窗口检查结束';
  const verb = toolEventVerb(tool.tool);
  // Files and URLs are useful targets. Raw commands, input JSON and tool
  // output stay in the original tool row rather than becoming a phase title.
  const legacyFileTarget = /^(read|edit|write|multiedit|notebookedit|notebook_edit)$/.test(name)
    && !/^\s*(?:\{|\[)/.test(tool.summary) ? tool.summary : undefined;
  const target = tool.input?.['file_path'] ?? tool.input?.['path'] ?? tool.input?.['url'] ?? legacyFileTarget;
  const label = typeof target === 'string'
    ? compactPhaseLabel(target.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? target)
    : '';
  return `${running ? `正在${verb}` : `${verb}完成`}${label ? ` · ${label}` : ''}`;
}

function phaseTitle(entries: readonly CodeProcessEntry[], active: boolean): string {
  const tools = entries.filter((entry): entry is ToolMessage => entry.kind === 'tool');
  const running = [...tools].reverse().find((entry) => (
    entry.status === 'running' || entry.status === 'pending'
  ));
  if (running) return phaseToolLabel(running, true);
  if (tools.some((entry) => entry.status === 'error')) return '操作需要处理';
  const latestThinking = [...entries].reverse().find(
    (entry): entry is ThinkingMessage => entry.kind === 'thinking',
  );
  // Only a note AFTER the last action can describe its latest finding. An
  // earlier thought is an intention, not evidence that a later action worked.
  const lastTool = tools.at(-1);
  if (!active && latestThinking && lastTool && entries.indexOf(latestThinking) > entries.indexOf(lastTool)) {
    const summary = compactPhaseLabel(latestThinking.summary.trim() || latestThinking.preview);
    if (summary) return summary;
  }
  if (tools.length > 0) {
    if (active) return '正在推进任务';
    if (lastTool) return phaseToolLabel(lastTool, false);
  }
  return active ? '正在思考' : '思考过程';
}

function CodeReasoningTranscriptImpl(
  props: CodeReasoningTranscriptProps,
): ReactElement {
  // One disclosure owns both raw reasoning and tools. Streaming opens by default;
  // completed history is compact, while a user's explicit choice always wins.
  const errorVisible = props.entries.some(entry => entry.kind === 'tool' && entry.status === 'error');
  const [autoExpanded, setAutoExpanded] = useState(props.active || errorVisible);
  const [userExpanded, setUserExpanded] = useConversationDisclosure(props.entries[0]?.id ?? props.turnId, 'process');
  const expanded = userExpanded ?? autoExpanded;
  const everExpanded = useRef(expanded);
  useEffect(() => { if (expanded) everExpanded.current = true; }, [expanded]);
  const wasActive = useRef(props.active);
  useEffect(() => {
    if (errorVisible) {
      if (userExpanded === null) setAutoExpanded(true);
      return;
    }
    if (props.active) {
      wasActive.current = true;
      if (userExpanded === null) setAutoExpanded(true);
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    // Give the terminal event time to settle before compacting the completed phase.
    const timer = window.setTimeout(() => {
      if (userExpanded === null) setAutoExpanded(false);
    }, 420);
    return () => window.clearTimeout(timer);
  }, [props.active, errorVisible, userExpanded]);

  const tools = props.entries.filter((entry): entry is ToolMessage => entry.kind === 'tool');
  const toolCount = tools.length;
  const PhaseIcon = phaseToolIcon([...tools].reverse().find(entry => entry.status === 'running' || entry.status === 'pending') ?? tools.at(-1));
  const hasRunningTool = tools.some(entry => entry.status === 'running' || entry.status === 'pending');
  const interrupted = !props.active && tools.some(entry => entry.status === 'interrupted');
  const unfinished = !props.active && hasRunningTool;
  const title = useMemo(() => phaseTitle(props.entries, props.active), [props.active, props.entries]);
  const reasoningExcerpt = toolCount === 0 ? compactPhaseLabel(props.entries
    .filter((entry): entry is ThinkingMessage => entry.kind === 'thinking')
    .map(entry => entry.summary.trim() || entry.preview.trim()).find(Boolean) ?? '') : '';
  // A finished process is neutral; error/interruption remain explicit.
  const hasError = errorVisible;
  const takeoverLabel = useMemo(() => takeoverBadgeLabel(props.entries), [props.entries]);
  return (
    <section
      className={`code-reasoning${props.active ? ' code-reasoning--active' : ''}${toolCount > 0 ? ' code-reasoning--tools' : ' code-reasoning--thinking'}${hasRunningTool ? ' code-reasoning--tool-running' : ''}${!props.active && !hasError && !interrupted && !unfinished ? ' code-reasoning--done' : ''}`}
      role="listitem"
      aria-label="执行过程"
      data-turn-id={props.turnId}
      data-phase-id={props.phaseId}
    >
      <button
        type="button"
        className="code-reasoning__head"
        onClick={() => setUserExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {(toolCount > 0 || props.active) && <span className="code-reasoning__state" aria-hidden="true">
          {hasError
            ? <AlertCircle size={15} strokeWidth={1.8} className="code-reasoning__state--error" />
            : interrupted || unfinished ? <Ban size={15} strokeWidth={1.8} />
              : props.active ? <Loader size={15} strokeWidth={1.8} className="code-reasoning__state--running" /> : <PhaseIcon size={15} strokeWidth={1.8} />}
        </span>}
        <span className="code-reasoning__summary">{interrupted ? '本次执行已中断' : unfinished ? '操作尚未完成' : title}</span>
        {!expanded && reasoningExcerpt ? <span className="code-reasoning__excerpt">{reasoningExcerpt}</span> : null}
        {takeoverLabel !== null && (
          <span
            className="code-reasoning__takeover-badge"
            title={`${takeoverLabel} · 后续操作已转为逐次审批`}
          >
            <Hand size={12} strokeWidth={2.2} aria-hidden="true" />
            {takeoverLabel}
          </span>
        )}
        {toolCount > 0 && <span className="code-reasoning__meta">{toolCount} 次操作</span>}
        <ChevronRight
          size={13}
          strokeWidth={1.8}
          className={`disclosure-chevron${expanded ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        />
      </button>

      <div className={`disclosure${expanded ? ' disclosure--open' : ''}`} aria-hidden={!expanded}>
        <div className="disclosure__inner">
          <div className="code-reasoning__transcript" aria-label="按时间顺序的执行过程">
            {(expanded || everExpanded.current) && props.entries.map((entry) => {
              if (entry.kind === 'tool') {
                return (
                  <div key={entry.id} className="code-reasoning__tool">
                    {computeFileChanges(entry.tool, entry.input, entry.outputContent).length > 0
                      ? <FileChangeCards variant="event" message={entry} workspacePath={props.workspacePath} onOpenFile={props.onOpenArtifact} />
                      : <ToolCard variant="event" message={entry} />}
                  </div>
                );
              }
              return <div className="code-reasoning__note" key={entry.id}>
                <EventReasoningNote message={entry} />
              </div>;
            })}
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
    if (a.workspacePath !== b.workspacePath || a.onOpenArtifact !== b.onOpenArtifact) return false;
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
