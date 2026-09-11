// Trylo Desktop — Remote projection (migration spec §8.2 / arch doc §7.3).
//
// The Desktop's PURE mapping layer from its OWN run state into the vendored
// Remote Gateway's `publish()` event vocabulary (the authority is
// desktop-services/vendor/legacy/remote-gateway/index.js). The gateway's
// in-memory snapshot is a mobile projection — NOT a second copy of business
// state (arch §7.3) — so this module never touches React, the DOM, or
// App.tsx. Every function is pure and table-testable; the RemoteController
// feeds the inputs and publishes the returned events.
//
// projectLoopEvents keeps its stream accumulators OUTSIDE the module: the
// caller owns the Maps and passes them on every call, so "delta = current
// length − previously accumulated length" is computed without any module
// state (the WeakMap idea was rejected to keep this layer pure).

import type {
  RemoteAgentStateEvent,
  RemoteGatewayEvent,
  RemoteIdeStreamTextEvent,
  RemoteIdeStreamThinkingEvent,
  RemotePermissionRequestStateEvent,
  RemotePermissionSummary,
  RemoteProjectSummary,
  RemoteProjectsStateEvent,
  RemoteSessionStateEvent,
  RemoteSessionSummary,
  RemoteTraceEvent,
  RemoteTurnEventEvent,
  RemoteTurnFinishedEvent,
  RemoteTurnStartedEvent,
} from '../services-host/methods';
import type { CodeRunViewState } from '../runtime/runtime-types';
import type { LoopEvent } from '../host-adapter/loop-events';
import type {
  ConversationKind,
  PersistedWorkspaceEntry,
  WorkspaceConversationHistory,
  WorkspaceIndex,
} from '../host-adapter/conversation-history';
import type { CodePermissionRequest } from '../runtime/code-permission-registry';
import type { PetPermissionRequest } from '../companion/companion-port';
import type { ChatMessage } from '../components/chat/types';

// ── string caps (gateway limits; mobile is the downstream consumer) ─────
const TITLE_CAP = 120;
const DETAIL_CAP = 240;
const TEXT_CAP = 24000;
const PREVIEW_CAP = 180;
const SESSION_LIMIT = 40;
const PROJECT_LIMIT = 40;

/** Code run binding state → gateway agentState vocabulary. The gateway
 *  normalizes idle/done/failed/waiting/thinking/else→running; we already
 *  speak that vocabulary, so nothing is re-classified here. `prev` is the
 *  last state we emitted — equal states return null (dedupe). */
export function projectBindingState(
  view: CodeRunViewState,
  prev?: string,
): RemoteAgentStateEvent | null {
  let state: string;
  let detail: string | undefined;
  switch (view.bindingState) {
    case 'spawning':
      state = 'running';
      detail = 'Starting the run';
      break;
    case 'busy':
      state = 'thinking';
      break;
    case 'ready':
    case 'idle':
      state = 'idle';
      break;
    case 'exited':
      if (view.error) {
        state = 'failed';
        detail = 'Run failed';
      } else {
        state = 'idle';
      }
      break;
  }
  if (state === prev) return null;
  return detail === undefined
    ? { type: 'agentState', state }
    : { type: 'agentState', state, detail };
}

/** Map a loop event batch into gateway publish() events. Streaming deltas
 *  are computed as (current length − accumulated length); the caller owns
 *  `thinkAccum` / `textAccum` and passes them every call so accumulation
 *  survives across batches without module state. Output is ordered by seq. */
export function projectLoopEvents(
  events: readonly LoopEvent[],
  turnId: string,
  mode: string,
  now?: () => number,
  thinkAccum?: Map<string, string>,
  textAccum?: Map<string, string>,
): RemoteGatewayEvent[] {
  const nowFn = now ?? (() => Date.now());
  const think = thinkAccum ?? new Map<string, string>();
  const text = textAccum ?? new Map<string, string>();
  const out: RemoteGatewayEvent[] = [];
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    const at = Number.isFinite(event.ts) ? event.ts : nowFn();
    switch (event.type) {
      case 'turn_start': {
        const turnStarted: RemoteTurnStartedEvent = {
          type: 'turnStarted',
          turn: { id: turnId, startedAt: at },
          at,
        };
        out.push(turnStarted);
        break;
      }
      case 'thinking': {
        const preview = event.preview.trim();
        const turnEvent: RemoteTurnEventEvent = {
          type: 'turnEvent',
          turnId,
          event: {
            category: 'reasoning',
            title: event.summary.trim().slice(0, TITLE_CAP),
            detail: preview,
            status: event.partial ? 'streaming' : 'done',
          },
          at,
        };
        out.push(turnEvent);
        const accumulated = think.get(turnId) ?? '';
        if (preview.length > accumulated.length) {
          const stream: RemoteIdeStreamThinkingEvent = {
            type: 'ideStreamThinking',
            turnId,
            delta: preview.slice(accumulated.length),
            at,
          };
          think.set(turnId, preview);
          out.push(stream);
        }
        break;
      }
      case 'text': {
        const current = (event.fullText ?? event.preview).trim();
        const accumulated = text.get(turnId) ?? '';
        if (current.length > accumulated.length) {
          const stream: RemoteIdeStreamTextEvent = {
            type: 'ideStreamText',
            turnId,
            delta: current.slice(accumulated.length),
            at,
          };
          text.set(turnId, current);
          out.push(stream);
        }
        break;
      }
      case 'tool_use': {
        const trace: RemoteTraceEvent = {
          type: 'trace',
          kind: 'tool',
          title: event.tool.trim().slice(0, TITLE_CAP),
          detail: JSON.stringify(event.input).slice(0, DETAIL_CAP),
          phase: 'running',
          at,
        };
        out.push(trace);
        break;
      }
      case 'tool_result': {
        const detail = event.ok ? '' : `error: ${event.error ?? ''}`;
        const trace: RemoteTraceEvent = {
          type: 'trace',
          kind: 'tool',
          title: event.tool.trim().slice(0, TITLE_CAP),
          detail: detail.trim().slice(0, DETAIL_CAP),
          phase: 'completed',
          at,
        };
        out.push(trace);
        break;
      }
      case 'loop_end': {
        const turnFinished: RemoteTurnFinishedEvent = {
          type: 'turnFinished',
          turn: {
            id: turnId,
            resultText: event.finalResult.trim().slice(0, TEXT_CAP),
            completedAt: at,
            mode,
          },
          at,
        };
        out.push(turnFinished);
        if (event.isError) out.push({ type: 'error', message: 'Run failed', at });
        break;
      }
      case 'aborted': {
        out.push({ type: 'stopped', at });
        break;
      }
      case 'session_end': {
        if (event.reason === 'abort') out.push({ type: 'stopped', at });
        else if (event.reason === 'error') out.push({ type: 'error', message: 'Run failed', at });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Last user/assistant text message, trimmed (empty when none). */
function lastUserAssistantText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.kind === 'text' && (message.role === 'user' || message.role === 'assistant')) {
      return message.text.trim();
    }
  }
  return '';
}

/** Project persisted conversations into the gateway's sessionState payload.
 *  The gateway's sessions are a mobile projection of the Desktop history —
 *  never a second store. */
export function projectSessionState(opts: {
  history: WorkspaceConversationHistory | null;
  kind: ConversationKind;
  now: () => number;
}): RemoteSessionStateEvent {
  const now = opts.now();
  if (!opts.history) {
    return { type: 'sessionState', activeSessionId: '', sessions: [], at: now };
  }
  const sessions: RemoteSessionSummary[] = Object.values(opts.history.conversations)
    .map((record) => {
      const title = record.session.title.trim();
      const lastMessage = record.messages[record.messages.length - 1];
      const updatedAt = lastMessage ? lastMessage.createdAt : now;
      return {
        id: record.session.id,
        title: title.slice(0, TITLE_CAP),
        preview: lastUserAssistantText(record.messages).slice(0, PREVIEW_CAP),
        updatedAt,
        workspace: { id: record.session.id, name: title.slice(0, TITLE_CAP), path: '' },
      };
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, SESSION_LIMIT);
  const activeSessionId = opts.history.activeByKind[opts.kind] ?? '';
  return { type: 'sessionState', activeSessionId, sessions, at: now };
}

/** Project the workspace index into the gateway's projectsState payload. */
export function projectProjectsState(opts: {
  index: WorkspaceIndex | null;
  currentWorkspace: PersistedWorkspaceEntry | null;
  now: () => number;
}): RemoteProjectsStateEvent {
  const lastSeenAt = opts.now();
  const projects: RemoteProjectSummary[] = (opts.index?.workspaces ?? [])
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name.trim().slice(0, TITLE_CAP),
      lastSeenAt,
    }))
    .slice(0, PROJECT_LIMIT);
  const activeProjectId = opts.currentWorkspace?.id ?? opts.index?.currentWorkspaceId ?? '';
  return { type: 'projectsState', projects, activeProjectId };
}

/** Merge Code + Work pending permissions into the gateway's
 *  permissionRequestState payload. Code wins on duplicate requestId. Risk is
 *  derived from category (command → medium, else low) — the same heuristic
 *  the gateway itself applies. */
export function projectApprovals(opts: {
  code: readonly CodePermissionRequest[];
  work: readonly PetPermissionRequest[];
  now: () => number;
}): RemotePermissionRequestStateEvent {
  const now = opts.now();
  const merged = new Map<string, RemotePermissionSummary>();
  for (const request of opts.work) {
    const category = request.category;
    merged.set(request.requestId, {
      requestId: request.requestId,
      ...(category !== undefined ? { category } : {}),
      title: request.title.trim().slice(0, TITLE_CAP),
      detail: (request.detail ?? '').trim().slice(0, DETAIL_CAP),
      description: (request.description ?? '').trim(),
      risk: category === 'command' ? 'medium' : 'low',
      requestedAt: now,
    });
  }
  for (const request of opts.code) {
    const title = (request.title && request.title.trim()) || request.toolName.trim();
    merged.set(request.requestId, {
      requestId: request.requestId,
      category: 'edit',
      title: title.slice(0, TITLE_CAP),
      detail: request.toolName.trim().slice(0, DETAIL_CAP),
      description: title,
      risk: 'low',
      requestedAt: now,
    });
  }
  return { type: 'permissionRequestState', requests: [...merged.values()], at: now };
}

/** Announce a mobile task receipt inside the frozen gateway vocabulary.
 *  The vendored gateway drops unknown publish() types, so the Code / Work
 *  surface distinction travels as an `agentState` detail (free text, shown
 *  on the phone's Runs page) plus a `trace` timeline entry (classified by
 *  the gateway as `progress`, visible in the phone timeline). `profileId`
 *  is the Work Tool Profile when the surface is work (e.g. work.core.v1);
 *  Code runs carry the code mode instead. */
export function projectTaskReceipt(opts: {
  surface: 'code' | 'work';
  mode: string;
  profileId?: string;
  now: () => number;
}): [RemoteAgentStateEvent, RemoteTraceEvent] {
  const at = opts.now();
  const surfaceLabel = opts.surface === 'work' ? 'Work' : 'Code';
  const qualifier = opts.surface === 'work'
    ? (opts.profileId?.trim() || 'work.core.v1')
    : opts.mode.trim() || 'agent';
  return [
    { type: 'agentState', state: 'running', detail: `${surfaceLabel} · ${qualifier}` },
    {
      type: 'trace',
      title: opts.surface === 'work' ? 'Work task received' : 'Code task received',
      detail: `${surfaceLabel} · ${qualifier}`.slice(0, DETAIL_CAP),
      phase: 'running',
      at,
    },
  ];
}

/** Full snapshot for gateway restart — agentState first, then the three
 *  list projections, filtered non-null. */
export function buildFullSnapshot(opts: {
  view: CodeRunViewState;
  history: WorkspaceConversationHistory | null;
  kind: ConversationKind;
  index: WorkspaceIndex | null;
  currentWorkspace: PersistedWorkspaceEntry | null;
  code: readonly CodePermissionRequest[];
  work: readonly PetPermissionRequest[];
  now: () => number;
}): RemoteGatewayEvent[] {
  const events: RemoteGatewayEvent[] = [];
  const binding = projectBindingState(opts.view);
  if (binding) events.push(binding);
  events.push(projectSessionState({ history: opts.history, kind: opts.kind, now: opts.now }));
  events.push(projectProjectsState({ index: opts.index, currentWorkspace: opts.currentWorkspace, now: opts.now }));
  events.push(projectApprovals({ code: opts.code, work: opts.work, now: opts.now }));
  return events;
}
