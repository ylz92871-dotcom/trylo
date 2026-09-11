// Trylo Desktop — remote projection table-driven tests (spec §8.2 / arch
// §7.3: the gateway snapshot is a mobile projection; every mapper is pure).

import { describe, expect, it } from 'vitest';

import {
  buildFullSnapshot,
  projectApprovals,
  projectBindingState,
  projectLoopEvents,
  projectProjectsState,
  projectSessionState,
  projectTaskReceipt,
} from './remote-projection';
import type { LoopEvent } from '../host-adapter/loop-events';
import type { CodeRunViewState } from '../runtime/runtime-types';
import type {
  ConversationRecord,
  WorkspaceConversationHistory,
  WorkspaceIndex,
} from '../host-adapter/conversation-history';
import type { CodePermissionRequest } from '../runtime/code-permission-registry';
import type { PetPermissionRequest } from '../companion/companion-port';
import type { ChatMessage } from '../components/chat/types';

// ── fixtures ────────────────────────────────────────────────────────────

function view(partial: Partial<CodeRunViewState> = {}): CodeRunViewState {
  return {
    running: false,
    error: false,
    activeProcessId: null,
    sendable: true,
    bindingState: 'idle',
    runId: null,
    pid: null,
    ...partial,
  };
}

function le(type: LoopEvent['type'], seq: number, extra: Record<string, unknown> = {}): LoopEvent {
  return { seq, ts: seq * 1000, type, ...extra } as unknown as LoopEvent;
}

function userMsg(id: string, text: string, at: number): ChatMessage {
  return { id, kind: 'text', role: 'user', createdAt: at, text, turnId: id };
}

function assistantMsg(id: string, text: string, at: number): ChatMessage {
  return { id, kind: 'text', role: 'assistant', createdAt: at, text, turnId: id };
}

function makeRecord(id: string, title: string, messages: readonly ChatMessage[], updatedAt: number): ConversationRecord {
  return {
    session: {
      id,
      title,
      mode: 'agent',
      kind: 'code',
      createdAt: updatedAt,
      updatedAt,
      turnCount: messages.filter((m) => m.kind === 'text' && m.role === 'user').length,
    },
    messages: messages as ChatMessage[],
    draft: '',
  };
}

// ── projectBindingState ─────────────────────────────────────────────────

describe('projectBindingState', () => {
  it('maps each binding state to the gateway agentState vocabulary (table)', () => {
    expect(projectBindingState(view({ bindingState: 'spawning' }))).toEqual({
      type: 'agentState',
      state: 'running',
      detail: 'Starting the run',
    });
    expect(projectBindingState(view({ bindingState: 'busy' }))).toEqual({
      type: 'agentState',
      state: 'thinking',
    });
    expect(projectBindingState(view({ bindingState: 'idle' }))).toEqual({
      type: 'agentState',
      state: 'idle',
    });
    expect(projectBindingState(view({ bindingState: 'ready' }))).toEqual({
      type: 'agentState',
      state: 'idle',
    });
    expect(projectBindingState(view({ bindingState: 'exited', error: false }))).toEqual({
      type: 'agentState',
      state: 'idle',
    });
    expect(projectBindingState(view({ bindingState: 'exited', error: true }))).toEqual({
      type: 'agentState',
      state: 'failed',
      detail: 'Run failed',
    });
  });

  it('returns null when the state is unchanged from prev (dedupe)', () => {
    expect(projectBindingState(view({ bindingState: 'idle' }), 'idle')).toBeNull();
    expect(projectBindingState(view({ bindingState: 'busy' }), 'thinking')).toBeNull();
    expect(projectBindingState(view({ bindingState: 'exited', error: true }), 'failed')).toBeNull();
  });

  it('emits when the state transitions away from prev', () => {
    expect(projectBindingState(view({ bindingState: 'busy' }), 'idle')).toEqual({
      type: 'agentState',
      state: 'thinking',
    });
    expect(projectBindingState(view({ bindingState: 'idle' }), 'running')).toEqual({
      type: 'agentState',
      state: 'idle',
    });
  });

  it('emits when prev is omitted (first call)', () => {
    expect(projectBindingState(view({ bindingState: 'idle' }))).toEqual({
      type: 'agentState',
      state: 'idle',
    });
  });
});

// ── projectLoopEvents ───────────────────────────────────────────────────

describe('projectLoopEvents', () => {
  const now = () => 9999;

  it('maps a full loop batch chronologically', () => {
    const events: LoopEvent[] = [
      le('turn_start', 1),
      le('thinking', 2, { turn: 1, preview: 'Let me reason about this task carefully', summary: 'Reasoning about the task', fullLength: 100, partial: true }),
      le('text', 3, { turn: 1, preview: 'I will check the repo first.' }),
      le('tool_use', 4, { turn: 1, id: 't1', tool: 'Bash', input: { command: 'ls -la' } }),
      le('tool_result', 5, { turn: 1, id: 't1', tool: 'Bash', ok: true, output: 'src', durationMs: 12 }),
      le('loop_end', 6, { durationMs: 100, totalCost: 0.1, numTurns: 1, reason: 'success', finalResult: 'Done.' }),
    ];
    const out = projectLoopEvents(events, 'turn-1', 'agent', now);
    expect(out).toEqual([
      { type: 'turnStarted', turn: { id: 'turn-1', startedAt: 1000 }, at: 1000 },
      {
        type: 'turnEvent',
        turnId: 'turn-1',
        event: {
          category: 'reasoning',
          title: 'Reasoning about the task',
          detail: 'Let me reason about this task carefully',
          status: 'streaming',
        },
        at: 2000,
      },
      { type: 'ideStreamThinking', turnId: 'turn-1', delta: 'Let me reason about this task carefully', at: 2000 },
      { type: 'ideStreamText', turnId: 'turn-1', delta: 'I will check the repo first.', at: 3000 },
      { type: 'trace', kind: 'tool', title: 'Bash', detail: '{"command":"ls -la"}', phase: 'running', at: 4000 },
      { type: 'trace', kind: 'tool', title: 'Bash', detail: '', phase: 'completed', at: 5000 },
      { type: 'turnFinished', turn: { id: 'turn-1', resultText: 'Done.', completedAt: 6000, mode: 'agent' }, at: 6000 },
    ]);
  });

  it('orders the output by seq even when the input is out of order', () => {
    const events: LoopEvent[] = [
      le('tool_use', 9, { turn: 1, id: 't', tool: 'Write', input: { path: 'a.ts' } }),
      le('turn_start', 1),
      le('loop_end', 12, { durationMs: 1, totalCost: 0, numTurns: 1, reason: 'success', finalResult: 'ok' }),
    ];
    const out = projectLoopEvents(events, 't', 'agent', now);
    expect(out.map((e) => e.type)).toEqual(['turnStarted', 'trace', 'turnFinished']);
  });

  it('emits only the incremental text delta across a batch (text accumulator)', () => {
    const events: LoopEvent[] = [
      le('text', 1, { turn: 1, preview: 'Hello' }),
      le('text', 2, { turn: 1, preview: 'Hello world' }),
    ];
    const textAccum = new Map<string, string>();
    const out = projectLoopEvents(events, 't', 'agent', now, undefined, textAccum);
    expect(out).toEqual([
      { type: 'ideStreamText', turnId: 't', delta: 'Hello', at: 1000 },
      { type: 'ideStreamText', turnId: 't', delta: ' world', at: 2000 },
    ]);
    expect(textAccum.get('t')).toBe('Hello world');
  });

  it('accumulates deltas across calls when the controller owns the maps', () => {
    const textAccum = new Map<string, string>();
    const first = projectLoopEvents([le('text', 1, { turn: 1, preview: 'abc' })], 't', 'agent', now, undefined, textAccum);
    const second = projectLoopEvents([le('text', 2, { turn: 1, preview: 'abcdef' })], 't', 'agent', now, undefined, textAccum);
    expect(first.map((e) => (e as { delta?: string }).delta)).toEqual(['abc']);
    expect(second.map((e) => (e as { delta?: string }).delta)).toEqual(['def']);
  });

  it('streams thinking preview growth incrementally', () => {
    const events: LoopEvent[] = [
      le('thinking', 1, { turn: 1, preview: 'one', summary: 's', fullLength: 3, partial: true }),
      le('thinking', 2, { turn: 1, preview: 'one two', summary: 's2', fullLength: 7, partial: false }),
    ];
    const thinkAccum = new Map<string, string>();
    const out = projectLoopEvents(events, 't', 'agent', now, thinkAccum);
    const deltas = out
      .filter((e): e is { type: 'ideStreamThinking'; delta: string } => e.type === 'ideStreamThinking')
      .map((e) => e.delta);
    expect(deltas).toEqual(['one', ' two']);
  });

  it('emits no ideStreamThinking when the preview did not grow', () => {
    const thinkAccum = new Map<string, string>([['t', 'same']]);
    const out = projectLoopEvents(
      [le('thinking', 1, { turn: 1, preview: 'same', summary: 's', fullLength: 4, partial: true })],
      't',
      'agent',
      now,
      thinkAccum,
    );
    expect(out).toEqual([
      { type: 'turnEvent', turnId: 't', event: { category: 'reasoning', title: 's', detail: 'same', status: 'streaming' }, at: 1000 },
    ]);
  });

  it('maps aborted to stopped', () => {
    expect(projectLoopEvents([le('aborted', 1, { reason: 'user' })], 't', 'agent', now)).toEqual([
      { type: 'stopped', at: 1000 },
    ]);
  });

  it('maps session_end abort/error to stopped/error and ignores other reasons', () => {
    const out = projectLoopEvents([
      le('session_end', 1, { sessionId: 's', durationMs: 1, reason: 'abort' }),
      le('session_end', 2, { sessionId: 's', durationMs: 1, reason: 'error' }),
      le('session_end', 3, { sessionId: 's', durationMs: 1, reason: 'success' }),
    ], 't', 'agent', now);
    expect(out).toEqual([
      { type: 'stopped', at: 1000 },
      { type: 'error', message: 'Run failed', at: 2000 },
    ]);
  });

  it('emits error after turnFinished when loop_end carries isError', () => {
    const out = projectLoopEvents([
      le('loop_end', 1, { durationMs: 1, totalCost: 0, numTurns: 1, reason: 'error', finalResult: '', isError: true }),
    ], 't', 'agent', now);
    expect(out).toEqual([
      { type: 'turnFinished', turn: { id: 't', resultText: '', completedAt: 1000, mode: 'agent' }, at: 1000 },
      { type: 'error', message: 'Run failed', at: 1000 },
    ]);
  });

  it('ignores event types outside the mapping table', () => {
    const out = projectLoopEvents([
      le('todo_updated', 1, { todos: [] }),
      le('compact', 2, { kind: 'boundary', tokensBefore: 1, tokensAfter: 2, reason: 'x' }),
      le('subagent', 3, { kind: 'spawn', id: 'a' }),
    ], 't', 'agent', now);
    expect(out).toEqual([]);
  });

  it('returns an empty array for no events', () => {
    expect(projectLoopEvents([], 't', 'agent', now)).toEqual([]);
  });

  it('slices titles to 120, trace detail to 240, resultText to 24000', () => {
    const longInput = { data: 'y'.repeat(500) };
    const events: LoopEvent[] = [
      le('thinking', 1, { turn: 1, preview: 'p', summary: 'x'.repeat(200), fullLength: 1, partial: false }),
      le('tool_use', 2, { turn: 1, id: 't', tool: 'Bash', input: longInput }),
      le('loop_end', 3, { durationMs: 1, totalCost: 0, numTurns: 1, reason: 'success', finalResult: 'z'.repeat(30000) }),
    ];
    const out = projectLoopEvents(events, 't', 'agent', now);
    const turnEvent = out.find((e) => e.type === 'turnEvent');
    const trace = out.find((e) => e.type === 'trace');
    const turnFinished = out.find((e) => e.type === 'turnFinished');
    expect((turnEvent as { event: { title: string } }).event.title.length).toBe(120);
    expect((trace as { detail?: string }).detail?.length).toBe(240);
    expect((turnFinished as { turn: { resultText: string } }).turn.resultText.length).toBe(24000);
  });
});

// ── projectSessionState ─────────────────────────────────────────────────

describe('projectSessionState', () => {
  const now = () => 5000;

  it('returns an empty event for null history', () => {
    expect(projectSessionState({ history: null, kind: 'code', now })).toEqual({
      type: 'sessionState',
      activeSessionId: '',
      sessions: [],
      at: 5000,
    });
  });

  it('projects conversations into session summaries sorted by updatedAt desc', () => {
    const history: WorkspaceConversationHistory = {
      version: 1,
      activeByKind: { code: 'c1', work: 'w1' },
      conversations: {
        c1: makeRecord('c1', 'First chat', [userMsg('m1', 'hello', 1000), assistantMsg('m2', 'hi back', 2000)], 2000),
        c2: makeRecord('c2', 'Second chat', [userMsg('m3', 'newer', 3000)], 3000),
      },
    };
    const out = projectSessionState({ history, kind: 'code', now });
    expect(out.type).toBe('sessionState');
    expect(out.activeSessionId).toBe('c1');
    expect(out.sessions.map((s) => s.id)).toEqual(['c2', 'c1']);
    expect(out.sessions[0]).toEqual({
      id: 'c2',
      title: 'Second chat',
      preview: 'newer',
      updatedAt: 3000,
      workspace: { id: 'c2', name: 'Second chat', path: '' },
    });
  });

  it('preview uses the last user/assistant message text', () => {
    const history: WorkspaceConversationHistory = {
      version: 1,
      activeByKind: { code: 'c1', work: null },
      conversations: {
        c1: makeRecord('c1', 'T', [userMsg('m1', 'hello', 1000), assistantMsg('m2', '  final answer  ', 2000)], 2000),
      },
    };
    const out = projectSessionState({ history, kind: 'code', now });
    expect(out.sessions[0]?.preview).toBe('final answer');
  });

  it('slices the preview to 180', () => {
    const history: WorkspaceConversationHistory = {
      version: 1,
      activeByKind: { code: 'c1', work: null },
      conversations: {
        c1: makeRecord('c1', 'T', [assistantMsg('m1', 'a'.repeat(300), 1000)], 1000),
      },
    };
    const out = projectSessionState({ history, kind: 'code', now });
    expect(out.sessions[0]?.preview?.length).toBe(180);
  });

  it('updatedAt falls back to now() when a session has no messages', () => {
    const history: WorkspaceConversationHistory = {
      version: 1,
      activeByKind: { code: null, work: null },
      conversations: { c1: makeRecord('c1', 'Empty', [], 100) },
    };
    const out = projectSessionState({ history, kind: 'code', now });
    expect(out.sessions[0]?.updatedAt).toBe(5000);
    expect(out.activeSessionId).toBe('');
  });

  it('caps the list at 40 sessions', () => {
    const conversations: Record<string, ConversationRecord> = {};
    for (let i = 0; i < 45; i += 1) {
      const id = `s${i}`;
      conversations[id] = makeRecord(id, `Session ${i}`, [userMsg(`${id}-m`, `msg ${i}`, i)], i);
    }
    const history: WorkspaceConversationHistory = {
      version: 1,
      activeByKind: { code: 's44', work: null },
      conversations,
    };
    const out = projectSessionState({ history, kind: 'code', now });
    expect(out.sessions.length).toBe(40);
  });
});

// ── projectProjectsState ────────────────────────────────────────────────

describe('projectProjectsState', () => {
  const now = () => 7777;

  it('projects the workspace index with lastSeenAt = now()', () => {
    const index: WorkspaceIndex = {
      version: 1,
      workspaces: [
        { id: 'w1', root: '/a', name: 'Alpha' },
        { id: 'w2', root: '/b', name: 'Beta' },
      ],
      currentWorkspaceId: 'w1',
      topModeByWorkspace: {},
    };
    expect(projectProjectsState({ index, currentWorkspace: null, now })).toEqual({
      type: 'projectsState',
      projects: [
        { id: 'w1', name: 'Alpha', lastSeenAt: 7777 },
        { id: 'w2', name: 'Beta', lastSeenAt: 7777 },
      ],
      activeProjectId: 'w1',
    });
  });

  it('prefers the current workspace for activeProjectId', () => {
    const index: WorkspaceIndex = { version: 1, workspaces: [], currentWorkspaceId: 'w9', topModeByWorkspace: {} };
    expect(projectProjectsState({ index, currentWorkspace: { id: 'w3', root: '/c', name: 'Gamma' }, now }).activeProjectId).toBe('w3');
  });

  it('handles a null index', () => {
    expect(projectProjectsState({ index: null, currentWorkspace: null, now })).toEqual({
      type: 'projectsState',
      projects: [],
      activeProjectId: '',
    });
  });

  it('caps projects at 40', () => {
    const workspaces = Array.from({ length: 45 }, (_, i) => ({ id: `w${i}`, root: `/w${i}`, name: `W${i}` }));
    const index: WorkspaceIndex = { version: 1, workspaces, currentWorkspaceId: 'w0', topModeByWorkspace: {} };
    expect(projectProjectsState({ index, currentWorkspace: null, now }).projects.length).toBe(40);
  });
});

// ── projectApprovals ────────────────────────────────────────────────────

describe('projectApprovals', () => {
  const now = () => 8888;

  const code: CodePermissionRequest[] = [{
    requestId: 'c1',
    processId: 'p',
    projectKey: 'k',
    conversationId: 'cv',
    toolName: 'Write',
    input: {},
    at: 1,
  }];
  const work: PetPermissionRequest[] = [
    { requestId: 'w1', title: 'Run tests', detail: 'npm test', description: 'npm test', category: 'command', approvalState: 'pending' },
    { requestId: 'w2', title: 'Edit file', detail: 'edit', description: 'edit', approvalState: 'pending' },
  ];

  it('maps work permissions with risk derived from category', () => {
    const out = projectApprovals({ code: [], work, now });
    expect(out.type).toBe('permissionRequestState');
    expect(out.requests[0]).toEqual({
      requestId: 'w1',
      category: 'command',
      title: 'Run tests',
      detail: 'npm test',
      description: 'npm test',
      risk: 'medium',
      requestedAt: 8888,
    });
    expect(out.requests[1]).toEqual({
      requestId: 'w2',
      title: 'Edit file',
      detail: 'edit',
      description: 'edit',
      risk: 'low',
      requestedAt: 8888,
    });
  });

  it('maps code permissions to edit category and low risk', () => {
    const out = projectApprovals({ code, work: [], now });
    expect(out.requests[0]).toEqual({
      requestId: 'c1',
      category: 'edit',
      title: 'Write',
      detail: 'Write',
      description: 'Write',
      risk: 'low',
      requestedAt: 8888,
    });
  });

  it('uses toolName as the fallback title for code permissions', () => {
    const req: CodePermissionRequest = {
      requestId: 'x', processId: 'p', projectKey: 'k', conversationId: 'cv', toolName: 'Grep', input: {}, at: 1,
    };
    const out = projectApprovals({ code: [req], work: [], now });
    expect(out.requests[0]?.title).toBe('Grep');
  });

  it('code wins on duplicate requestId', () => {
    const dupCode: CodePermissionRequest[] = [{ ...code[0]!, requestId: 'w1', toolName: 'Bash' }];
    const out = projectApprovals({ code: dupCode, work, now });
    const entry = out.requests.find((r) => r.requestId === 'w1');
    expect(entry).toEqual({
      requestId: 'w1',
      category: 'edit',
      title: 'Bash',
      detail: 'Bash',
      description: 'Bash',
      risk: 'low',
      requestedAt: 8888,
    });
  });
});

// ── buildFullSnapshot ───────────────────────────────────────────────────

describe('buildFullSnapshot', () => {
  const now = () => 999;
  const opts = {
    view: view({ bindingState: 'idle' }),
    history: null,
    kind: 'code' as const,
    index: null,
    currentWorkspace: null,
    code: [] as CodePermissionRequest[],
    work: [] as PetPermissionRequest[],
    now,
  };

  it('emits agentState first followed by session/projects/approvals', () => {
    const out = buildFullSnapshot(opts);
    expect(out.map((e) => e.type)).toEqual([
      'agentState',
      'sessionState',
      'projectsState',
      'permissionRequestState',
    ]);
  });

  it('leads with the failed agentState when the binding errored', () => {
    const out = buildFullSnapshot({ ...opts, view: view({ bindingState: 'exited', error: true }) });
    expect(out[0]).toEqual({ type: 'agentState', state: 'failed', detail: 'Run failed' });
  });
});

// ── projectTaskReceipt ──────────────────────────────────────────────────
// Frozen-gateway vocabulary only: an agentState (free-text detail) plus a
// trace timeline entry. No new event types — the gateway drops those.

describe('projectTaskReceipt', () => {
  const now = () => 777;

  it('announces a work task with the profile id in both events', () => {
    const [state, trace] = projectTaskReceipt({ surface: 'work', mode: 'agent', profileId: 'work.cad.v1', now });
    expect(state).toEqual({ type: 'agentState', state: 'running', detail: 'Work · work.cad.v1' });
    expect(trace).toEqual({
      type: 'trace',
      title: 'Work task received',
      detail: 'Work · work.cad.v1',
      phase: 'running',
      at: 777,
    });
  });

  it('defaults a blank work profile to work.core.v1', () => {
    const [state] = projectTaskReceipt({ surface: 'work', mode: 'agent', profileId: '  ', now });
    expect(state).toEqual({ type: 'agentState', state: 'running', detail: 'Work · work.core.v1' });
  });

  it('announces a code task with the code mode', () => {
    const [state, trace] = projectTaskReceipt({ surface: 'code', mode: 'plan', now });
    expect(state).toEqual({ type: 'agentState', state: 'running', detail: 'Code · plan' });
    expect(trace).toMatchObject({ type: 'trace', title: 'Code task received', phase: 'running' });
  });
});
