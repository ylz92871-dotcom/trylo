// Trylo Desktop — ManagedWorkCoordinator (P3-B2/B3/B4, audit §4.4).
//
// The long-term owner of the managed-work (CoWork ManagedSession) child loop on
// the Desktop side. The CLI's AgentTool only submits the WorkOrder and returns a
// machine-readable receipt; the background session is NOT owned by the short-lived
// CLI connection. This coordinator:
//
//   B2 — owns a control-plane connection to workd, turns the CLI `subagent`
//        spawn/end lifecycle events into ManagedChildBindings (persisted via
//        `onBindingChange`), subscribes to `managedSession.*` broadcasts and
//        projects them as `subagent` messages (id = `managed:<parentToolUseId>`).
//   B3 — `input.requested` → ApprovalMessage (authority `managed`); allow/deny
//        writes back via `managedSession.sendEvent(input.received)`; continue
//        → `sendEvent(user.message)` to the SAME session; cancel → `cancel`.
//   B4 — `reconcile(activeBindings)` on app start: `managedSession.get` per
//        binding; not_found → orphaned, daemon unreachable → unavailable,
//        never fabricate a replacement session. Terminal sessions are read-only.
//
// The module is pure (no React / Tauri): the App wires the control-plane client
// and the message sink. Everything here is unit-testable against a fake client.

import type { ChatMessage, SubagentMessage, ApprovalMessage } from '../components/chat/types';
import type { SubagentEvent } from '../host-adapter/loop-events';
import { bindManagedChild, listActive, type ManagedChildBindings } from './managed-child-binding';
import type { ManagedChildBinding } from './managedWorkTypes';
import {
  buildInputReceivedEvent,
  isAlreadyDecided,
  pendingActionFromFrame,
  type ManagedDecision,
  type ManagedPendingAction,
} from './managed-approval-bridge';

/** The subset of the workd control-plane client the coordinator needs. */
export interface ManagedWorkControlPlaneLike {
  readonly status: () => string;
  readonly connect: () => void;
  readonly disconnect: () => void;
  readonly send: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  readonly whenReady: (timeoutMs?: number) => Promise<void>;
  readonly on: (event: string, handler: (frame: WorkdEventFrameLike) => void) => () => void;
}

export interface WorkdEventFrameLike {
  readonly event: string;
  readonly payload?: unknown;
  readonly seq?: number;
}

export interface ManagedWorkCoordinatorOptions {
  readonly client: ManagedWorkControlPlaneLike;
  /** Default workspace root, used until a binding pins its own projectKey. */
  readonly projectKey: string;
  /** Projection sink — the App routes each message into the right workspace
   *  (`root`) + conversation. */
  readonly onMessage: (root: string, conversationId: string, message: ChatMessage) => void;
  /** Binding persistence sink — the App writes it into conversation history. */
  readonly onBindingChange: (binding: ManagedChildBinding) => void;
  /** Optional scanner for per-session deliverables (relativePath list). */
  readonly listArtifacts?: (projectKey: string, managedSessionId: string) => Array<{ relativePath: string; kind?: string }>;
}

const MANAGED_EVENT_NAMES = [
  'managedSession.created',
  'managedSession.updated',
  'managedSession.event',
  'managedSession.completed',
  'managedSession.failed',
] as const;

/** Map a daemon session status to the Trylo subagent card status. */
export function mapManagedStatus(raw: string | undefined): SubagentMessage['status'] {
  switch (raw) {
    case 'pending':
      return 'running';
    case 'running':
      return 'running';
    case 'awaiting_input':
    case 'interrupted':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

/** Stable card id so spawn → end → live updates all land on ONE card. */
export function cardIdFor(parentToolUseId: string | undefined, managedSessionId: string): string {
  return parentToolUseId ? `managed:${parentToolUseId}` : `managed:${managedSessionId}`;
}

export function approvalIdFor(sessionId: string, requestId: string): string {
  return `managed:approval:${sessionId}:${requestId}`;
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  if (typeof p.text === 'string' && p.text.trim()) return p.text;
  if (typeof p.message === 'string' && p.message.trim()) return p.message;
  if (Array.isArray(p.content)) {
    const text = p.content
      .map((c) => (c && typeof c === 'object' ? (c as { text?: unknown }).text : undefined))
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
    if (text.trim()) return text;
  }
  return '';
}

/**
 * Upsert a coordinator-emitted message into the message list by stable id.
 * Used by the App instead of `applyEvents` (which only understands loop events)
 * so a status update replaces the previous card in place.
 */
export function applyManagedMessage(msgs: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const idx = msgs.findIndex((m) => m.id === message.id);
  if (idx < 0) return [...msgs, message];
  return msgs.map((m, i) => (i === idx ? message : m));
}

/** Build a SubagentMessage for a binding + session state. */
export function buildSubagentMessage(
  binding: ManagedChildBinding,
  state: {
    status?: string;
    summary?: string;
    artifacts?: readonly string[];
    error?: string;
    pendingAction?: ManagedPendingAction | null;
  } = {},
): SubagentMessage {
  const status = mapManagedStatus(state.status ?? binding.status);
  return {
    id: cardIdFor(binding.parentToolUseId, binding.managedSessionId),
    kind: 'subagent',
    role: 'system',
    createdAt: binding.createdAt || Date.now(),
    status,
    agentType: 'managed-work',
    prompt: undefined,
    managedSessionId: binding.managedSessionId,
    backingTaskId: binding.backingTaskId,
    ...(state.summary ? { summary: state.summary } : {}),
    ...(state.artifacts && state.artifacts.length > 0 ? { artifacts: state.artifacts } : {}),
    ...(state.error ? { result: state.error } : {}),
  };
}

function buildApprovalMessage(
  sessionId: string,
  action: ManagedPendingAction,
  status: ApprovalMessage['status'] = 'pending',
): ApprovalMessage {
  return {
    id: approvalIdFor(sessionId, action.requestId),
    kind: 'approval',
    role: 'system',
    createdAt: Date.now(),
    approvalId: approvalIdFor(sessionId, action.requestId),
    type: action.type === 'approval' ? 'approval' : undefined,
    description: action.description,
    status,
    authority: 'managed',
  };
}

export class ManagedWorkCoordinator {
  private readonly client: ManagedWorkControlPlaneLike;
  private readonly onMessage: (root: string, conversationId: string, message: ChatMessage) => void;
  private readonly onBindingChange: (binding: ManagedChildBinding) => void;
  private readonly listArtifactsFn: (projectKey: string, managedSessionId: string) => Array<{ relativePath: string; kind?: string }>;

  /** Keyed by managedSessionId. */
  private bindings: ManagedChildBindings = {};
  /** parentToolUseId → { root, conversationId, prompt } captured at spawn so the
   *  end event (which carries the session id) can bind to the right workspace +
   *  conversation. */
  private pendingSpawns = new Map<string, { root: string; conversationId: string; prompt?: string }>();
  /** requestIds already surfaced/decided — a denied request must never be
   *  re-surfaced as a fresh approval (§7.4). */
  private decidedRequestIds = new Set<string>();
  private unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(options: ManagedWorkCoordinatorOptions) {
    this.client = options.client;
    this.onMessage = options.onMessage;
    this.onBindingChange = options.onBindingChange;
    this.listArtifactsFn =
      options.listArtifacts ??
      (() => {
        // No-op default: the App supplies the scanner.
        return [];
      });
    for (const name of MANAGED_EVENT_NAMES) {
      this.unsubscribers.push(this.client.on(name, (frame) => this.handleWorkdFrame(frame)));
    }
  }

  /** Current bindings (for persistence / tests). */
  snapshot(): ManagedChildBindings {
    return { ...this.bindings };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }

  // ---- B2: CLI lifecycle events → binding + subscription -----------------

  /** Feed a CLI `subagent` loop event (from the App's onEvents). */
  handleSubagentEvent(root: string, conversationId: string, event: SubagentEvent): void {
    if (this.disposed) return;
    if (event.kind === 'spawn' && event.agentType === 'managed-work') {
      this.pendingSpawns.set(event.id, { root, conversationId, prompt: event.prompt });
      this.emitSubagentCard({
        id: cardIdFor(event.id, event.id),
        kind: 'subagent',
        role: 'system',
        createdAt: event.ts,
        status: 'running',
        agentType: 'managed-work',
        prompt: event.prompt,
      }, root, conversationId);
      return;
    }
    if (event.kind === 'end' && event.agentType === 'managed-work') {
      const spawn = this.pendingSpawns.get(event.id);
      const effectiveRoot = spawn?.root ?? root;
      const convId = spawn?.conversationId ?? conversationId;
      this.pendingSpawns.delete(event.id);

      const managed = event.managed;
      if (!managed?.managedSessionId) {
        // Daemon unavailable / failed before a session was created.
        this.emitSubagentCard({
          id: cardIdFor(event.id, event.id),
          kind: 'subagent',
          role: 'system',
          createdAt: event.ts,
          status: 'failed',
          agentType: 'managed-work',
          prompt: spawn?.prompt,
          result: managed?.error ?? event.result ?? 'managed-work unavailable',
        }, effectiveRoot, convId);
        return;
      }

      const candidate: ManagedChildBinding = {
        childId: managed.childId ?? `managed-${managed.managedSessionId}`,
        projectKey: effectiveRoot,
        conversationId: convId,
        parentRunId: '',
        parentToolUseId: event.id,
        managedSessionId: managed.managedSessionId,
        backingTaskId: managed.backingTaskId,
        status: mapManagedStatus(managed.status),
        createdAt: event.ts,
        updatedAt: Date.now(),
      };
      const { binding } = bindManagedChild(this.bindings, candidate);
      this.bindings = { ...this.bindings, [binding.managedSessionId]: binding };
      this.onBindingChange(binding);
      this.emitSubagentMessage(binding, {
        status: managed.status,
        artifacts: (managed.artifacts ?? []).map((a) => a.relativePath),
        error: managed.error,
      });
      return;
    }
  }

  // ---- B3: approvals / continue / cancel ---------------------------------

  /** Bridge an ApprovalCard decision back to the daemon. */
  async respondToApproval(sessionId: string, requestId: string, decision: ManagedDecision): Promise<boolean> {
    const binding = this.bindings[sessionId];
    if (!binding) return false;
    // Mark decided BEFORE the network round-trip so a repeated broadcast of the
    // same requestId cannot re-surface a fresh approval while we are in flight
    // (§7.4: a denied request is never re-surfaced).
    if (this.decidedRequestIds.has(requestId)) return true;
    this.decidedRequestIds.add(requestId);
    try {
      await this.client.send('managedSession.sendEvent', {
        sessionId,
        event: buildInputReceivedEvent(requestId, decision),
      });
    } catch {
      return false;
    }
    const status: ApprovalMessage['status'] = decision === 'allow' ? 'approved' : 'denied';
    this.onMessage(binding.projectKey, binding.conversationId, {
      ...buildApprovalMessage(sessionId, { type: 'approval', requestId, description: '' }, status),
      description: '',
    });
    // Refresh the card status off the authoritative session.
    void this.refreshFromDaemon(sessionId);
    return true;
  }

  /** Continue a session with a follow-up instruction — targets the SAME session. */
  async continueSession(sessionId: string, text: string): Promise<boolean> {
    const binding = this.bindings[sessionId];
    if (!binding) return false;
    try {
      await this.client.send('managedSession.sendEvent', {
        sessionId,
        event: { type: 'user.message', content: [{ type: 'text', text }] },
      });
    } catch {
      return false;
    }
    this.emitSubagentMessage(binding, { status: 'running' });
    void this.refreshFromDaemon(sessionId);
    return true;
  }

  /** Cancel a managed session. */
  async cancelSession(sessionId: string): Promise<boolean> {
    const binding = this.bindings[sessionId];
    if (!binding) return false;
    try {
      await this.client.send('managedSession.cancel', { sessionId });
    } catch {
      return false;
    }
    this.emitSubagentMessage(binding, { status: 'cancelled' });
    void this.refreshFromDaemon(sessionId);
    return true;
  }

  // ---- B4: restart recovery ----------------------------------------------

  /**
   * Reconcile persisted non-terminal bindings against the daemon's authoritative
   * state (audit §4.4 B4 + cowork doc §8.2). Called once on app start after
   * bindings are loaded from conversation history.
   */
  async reconcile(active: readonly ManagedChildBinding[]): Promise<void> {
    for (const binding of active) {
      if (this.bindings[binding.managedSessionId]) continue;
      this.bindings = { ...this.bindings, [binding.managedSessionId]: binding };
    }
    const candidates = listActive(this.bindings);
    await Promise.all(
      candidates.map(async (binding) => {
        let status: string;
        let error: string | undefined;
        try {
          const result = await this.client.send<{ session?: { status?: string; error?: string } }>(
            'managedSession.get',
            { sessionId: binding.managedSessionId },
          );
          status = result?.session?.status ?? binding.status;
          error = result?.session?.error;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/not found|not_found|INVALID_PARAMS/i.test(message)) {
            status = 'orphaned';
          } else {
            status = 'unavailable';
          }
          error = message;
        }
        const refreshed: ManagedChildBinding = { ...binding, status, updatedAt: Date.now() };
        this.bindings = {
          ...this.bindings,
          [binding.managedSessionId]: refreshed,
        };
        this.onBindingChange(refreshed);
        if (status !== 'unavailable') {
          this.emitSubagentMessage(refreshed, {
            status,
            error,
          });
        }
      }),
    );
  }

  // ---- workd event handling ----------------------------------------------

  private handleWorkdFrame(frame: WorkdEventFrameLike): void {
    if (this.disposed) return;
    const payload = frame.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') return;
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) return;
    const binding = this.bindings[sessionId];
    if (!binding) return;

    // Live managed session event: { sessionId, event: { type, payload } }
    const event = payload.event as Record<string, unknown> | undefined;
    if (event && typeof event === 'object') {
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'input.requested') {
        const action = pendingActionFromFrame({ event });
        if (action && !isAlreadyDecided(action.requestId, this.decidedRequestIds)) {
          this.onMessage(binding.projectKey, binding.conversationId, buildApprovalMessage(sessionId, action));
        }
        return;
      }
      if (type === 'assistant.message') {
        const summary = extractText(event.payload);
        if (summary) this.emitSubagentMessage(binding, { status: 'running', summary });
        return;
      }
      if (type === 'status.changed' || type === 'session.completed' || type === 'session.failed') {
        const raw = (event.payload as Record<string, unknown> | undefined)?.status;
        const to = typeof raw === 'string' ? raw : undefined;
        this.emitSubagentMessage(binding, { status: to ?? binding.status });
        return;
      }
      return;
    }

    // Session-object broadcasts: { sessionId, session }
    const session = payload.session as Record<string, unknown> | undefined;
    if (session && typeof session === 'object') {
      const status = typeof session.status === 'string' ? session.status : binding.status;
      const summary = typeof session.latestSummary === 'string' ? session.latestSummary : undefined;
      const error = typeof session.error === 'string' ? session.error : undefined;
      this.emitSubagentMessage(binding, { status, summary, error });
    }
  }

  private emitSubagentCard(message: SubagentMessage, root: string, conversationId: string): void {
    this.onMessage(root, conversationId, message);
  }

  private emitSubagentMessage(binding: ManagedChildBinding, state: {
    status?: string;
    summary?: string;
    error?: string;
    artifacts?: readonly string[];
  }): void {
    const artifacts =
      state.artifacts ??
      this.listArtifactsFn(binding.projectKey, binding.managedSessionId).map((a) => a.relativePath);
    const message = buildSubagentMessage(binding, { ...state, artifacts });
    this.onMessage(binding.projectKey, binding.conversationId, message);
  }

  private async refreshFromDaemon(sessionId: string): Promise<void> {
    const binding = this.bindings[sessionId];
    if (!binding) return;
    try {
      const result = await this.client.send<{ session?: { status?: string; latestSummary?: string; error?: string } }>(
        'managedSession.get',
        { sessionId },
      );
      const s = result?.session;
      if (!s) return;
      this.emitSubagentMessage(binding, {
        status: s.status,
        summary: s.latestSummary,
        error: s.error,
      });
    } catch {
      // keep the last projected state
    }
  }
}
