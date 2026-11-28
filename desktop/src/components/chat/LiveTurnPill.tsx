import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Check, Clock3 } from 'lucide-react';
import type { ChatMessage, TextMessage, ToolMessage } from './types';
import { isTurnTiming } from './types';
import {
  type ConversationRunViewState,
  viewStateLabel,
  viewStateTone,
} from './view-state';
import { toolEventTargetLabel, toolEventVerb } from './tool-event-presentation';
import { PartialTextTransition } from './PartialTextTransition';

export interface LiveTurnPillProps {
  readonly viewState: ConversationRunViewState;
  readonly messages: readonly ChatMessage[];
  readonly running: boolean;
}

const ACTIVE_STATES = new Set<ConversationRunViewState>([
  'preparing',
  'waiting_first_output',
  'waiting_model',
  'thinking',
  'tool_running',
  'finalizing',
  'awaiting_input',
  'reconnecting',
  'stopping',
]);

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = String(seconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

/**
 * Shared Code & Work live status pill anchored above the composer.
 * Driven strictly by real `ConversationRunViewState` and current-turn messages;
 * never invents fake percentages and obeys the single-loop motion policy (no infinite spinners).
 */
export function LiveTurnPill(props: LiveTurnPillProps): ReactElement | null {
  const { viewState, messages, running } = props;

  const turnFacts = useMemo(() => {
    let userIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.kind === 'text' && m.role === 'user' && m.steerState === undefined) {
        userIndex = i;
        break;
      }
    }
    const userMsg: TextMessage | undefined = userIndex >= 0 ? (messages[userIndex] as TextMessage) : undefined;
    const turnSlice = userIndex >= 0 ? messages.slice(userIndex + 1) : messages;
    const tools = turnSlice.filter((m): m is ToolMessage => m.kind === 'tool');
    const doneSteps = tools.filter((t) => t.status === 'done').length;
    const activeTool = [...tools].reverse().find((t) => t.status === 'running' || t.status === 'pending');

    return {
      userMsg,
      startedAt: userMsg?.turnStartedAt ?? userMsg?.createdAt ?? null,
      terminal: Boolean(userMsg?.turnTiming && isTurnTiming(userMsg.turnTiming)) && !running,
      doneSteps,
      totalTools: tools.length,
      activeTool,
    };
  }, [messages, running]);

  const active = ACTIVE_STATES.has(viewState) && !turnFacts.terminal;
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active || turnFacts.startedAt === null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, turnFacts.startedAt]);

  if (!active) return null;

  let phaseLabel = viewStateLabel(viewState);
  if (viewState === 'tool_running' && turnFacts.activeTool) {
    const verb = toolEventVerb(turnFacts.activeTool.tool);
    const target = toolEventTargetLabel(turnFacts.activeTool);
    phaseLabel = target ? `${verb} ${target}` : `${verb}…`;
  }

  const tone = viewStateTone(viewState);
  const elapsed = turnFacts.startedAt !== null ? formatElapsed(now - turnFacts.startedAt) : null;

  return (
    <div
      className="live-turn-pill"
      data-state={viewState}
      data-tone={tone}
      role="status"
      aria-live="polite"
    >
      <span className="live-turn-pill__dot" aria-hidden="true" />
      <span className="live-turn-pill__phase">
        <PartialTextTransition value={phaseLabel} />
      </span>
      {turnFacts.doneSteps > 0 && (
        <span className="live-turn-pill__steps">
          <Check size={12} strokeWidth={2.2} aria-hidden="true" />
          <span>已完成</span>
          <PartialTextTransition value={turnFacts.doneSteps} numeric />
          <span>步</span>
        </span>
      )}
      {elapsed !== null && (
        <span className="live-turn-pill__elapsed">
          <Clock3 size={12} aria-hidden="true" />
          <span>{elapsed}</span>
        </span>
      )}
    </div>
  );
}
