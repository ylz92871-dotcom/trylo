// Trylo — ManagedWorkCoordinator unit tests (P3-B2/B3/B4).
// Run: npx vitest run src/managed-work/managed-work-coordinator.test.ts

import { describe, expect, it } from 'vitest';
import type { ChatMessage, ApprovalMessage, SubagentMessage } from '../components/chat/types';
import type { SubagentEvent } from '../host-adapter/loop-events';
import {
  ManagedWorkCoordinator,
  applyManagedMessage,
  approvalIdFor,
  buildSubagentMessage,
  cardIdFor,
  type ManagedWorkControlPlaneLike,
  type WorkdEventFrameLike,
} from './managed-work-coordinator';
import type { ManagedChildBinding } from './managedWorkTypes';

function makeSpawn(toolUseId: string): SubagentEvent {
  return { type: 'subagent', kind: 'spawn', id: toolUseId, agentType: 'managed-work', prompt: 'do the work', seq: 1, ts: 1 };
}

function makeEnd(toolUseId: string, over: Partial<NonNullable<SubagentEvent['managed']>> = {}): SubagentEvent {
  return {
    type: 'subagent',
    kind: 'end',
    id: toolUseId,
    agentType: 'managed-work',
    result: 'receipt text',
    seq: 2,
    ts: 2,
    managed: {
      childId: `managed-sess-1`,
      managedSessionId: 'sess-1',
      backingTaskId: 'task-1',
      status: 'running',
      delivery: 'background',
      artifacts: [{ relativePath: '.trylo/out/managed/sess-1/report.md', kind: 'file' }],
      ...over,
    },
  };
}

function makeBinding(over: Partial<ManagedChildBinding> = {}): ManagedChildBinding {
  return {
    childId: 'managed-sess-1',
    projectKey: 'D:/ws',
    conversationId: 'conv-1',
    parentRunId: '',
    parentToolUseId: 'tool-use-1',
    managedSessionId: 'sess-1',
    backingTaskId: 'task-1',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** Fake workd control-plane client. */
class FakeClient implements ManagedWorkControlPlaneLike {
  sends: Array<{ method: string; params: unknown }> = [];
  listeners = new Map<string, Set<(frame: WorkdEventFrameLike) => void>>();
  getResponses = new Map<string, unknown>();

  status = () => 'connected';
  connect = () => {};
  disconnect = () => {};
  whenReady = async () => {};
  on = (event: string, handler: (frame: WorkdEventFrameLike) => void) => {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  };
  send = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
    this.sends.push({ method, params });
    if (method === 'managedSession.get') {
      const sessionId = (params as { sessionId?: string })?.sessionId ?? '';
      const key = sessionId;
      if (this.getResponses.has(key)) return this.getResponses.get(key) as T;
      return { session: { id: sessionId, status: 'running', backingTaskId: 'task-1' } } as T;
    }
    if (method === 'managedSession.sendEvent' || method === 'managedSession.cancel') {
      const sessionId = (params as { sessionId?: string })?.sessionId ?? '';
      return { session: { id: sessionId, status: 'running' } } as T;
    }
    return {} as T;
  };
  emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.forEach((h) => h({ event, payload }));
  }
}

function setup() {
  const client = new FakeClient();
  const messages: Array<{ root: string; conversationId: string; message: ChatMessage }> = [];
  const bindingChanges: ManagedChildBinding[] = [];
  const coordinator = new ManagedWorkCoordinator({
    client,
    projectKey: 'D:/ws',
    onMessage: (root, conversationId, message) => messages.push({ root, conversationId, message }),
    onBindingChange: (b) => bindingChanges.push(b),
    listArtifacts: () => [{ relativePath: '.trylo/out/managed/sess-1/report.md', kind: 'file' }],
  });
  return { client, coordinator, messages, bindingChanges };
}

describe('B2: CLI lifecycle → binding + card', () => {
  it('spawn emits a running card; end binds and flips to the receipt status', () => {
    const { coordinator, messages, bindingChanges } = setup();
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeEnd('tool-use-1'));

    expect(messages[0]!.conversationId).toBe('conv-1');
    expect((messages[0]!.message as SubagentMessage).status).toBe('running');

    const card = messages[1]!.message as SubagentMessage;
    expect(card.id).toBe(cardIdFor('tool-use-1', 'sess-1'));
    expect(card.managedSessionId).toBe('sess-1');
    expect(card.backingTaskId).toBe('task-1');

    expect(bindingChanges).toHaveLength(1);
    expect(bindingChanges[0]!.managedSessionId).toBe('sess-1');
    expect(bindingChanges[0]!.parentToolUseId).toBe('tool-use-1');
    expect(bindingChanges[0]!.conversationId).toBe('conv-1');
  });

  it('replaying the SAME parentToolUseId never creates a second session/binding', () => {
    const { coordinator, bindingChanges } = setup();
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeEnd('tool-use-1', { managedSessionId: 'sess-1' }));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeEnd('tool-use-1', { managedSessionId: 'sess-DIFFERENT' }));

    const sessions = new Set(bindingChanges.map((b) => b.managedSessionId));
    expect(sessions).toEqual(new Set(['sess-1']));
  });

  it('end without a managed receipt (daemon unavailable) emits a failed card', () => {
    const { coordinator, messages } = setup();
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', {
      ...makeEnd('tool-use-1'),
      managed: undefined,
      result: 'managed-work unavailable',
    });
    const card = messages[1]!.message as SubagentMessage;
    expect(card.status).toBe('failed');
    expect(card.result).toContain('managed-work unavailable');
  });
});

describe('B2/B4: workd event projection', () => {
  it('managedSession.updated flips the card to waiting/completed', () => {
    const { coordinator, client, messages } = setup();
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeEnd('tool-use-1'));

    client.emit('managedSession.updated', { sessionId: 'sess-1', session: { id: 'sess-1', status: 'awaiting_input' } });
    const waiting = messages[messages.length - 1]!.message as SubagentMessage;
    expect(waiting.status).toBe('waiting');

    client.emit('managedSession.completed', { sessionId: 'sess-1', session: { id: 'sess-1', status: 'completed', latestSummary: 'Done' } });
    const done = messages[messages.length - 1]!.message as SubagentMessage;
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Done');
  });

  it('managedSession.event assistant.message updates the summary', () => {
    const { coordinator, client, messages } = setup();
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeEnd('tool-use-1'));

    client.emit('managedSession.event', {
      sessionId: 'sess-1',
      event: { type: 'assistant.message', payload: { content: [{ type: 'text', text: 'working through the data' }] } },
    });
    const card = messages[messages.length - 1]!.message as SubagentMessage;
    expect(card.summary).toBe('working through the data');
  });
});

describe('B3: approval bridge', () => {
  it('input.requested surfaces an ApprovalCard; deny writes input.received(denied) and is not re-surfaced', () => {
    const { coordinator, client, messages } = setup();
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeEnd('tool-use-1'));

    client.emit('managedSession.event', {
      sessionId: 'sess-1',
      event: {
        type: 'input.requested',
        payload: { request: { id: 'req-1', questions: [{ prompt: 'Delete prod.db?' }] } },
      },
    });

    const approval = messages[messages.length - 1]!.message as ApprovalMessage;
    expect(approval.kind).toBe('approval');
    expect(approval.authority).toBe('managed');
    expect(approval.approvalId).toBe(approvalIdFor('sess-1', 'req-1'));
    expect(approval.status).toBe('pending');

    // Deny → sendEvent(input.received, status: denied)
    void coordinator.respondToApproval('sess-1', 'req-1', 'deny');
    const sendEvent = client.sends.find((s) => s.method === 'managedSession.sendEvent');
    expect(sendEvent?.params).toMatchObject({
      sessionId: 'sess-1',
      event: { type: 'input.received', requestId: 'req-1', status: 'denied' },
    });

    // The same requestId must not be re-surfaced as a fresh approval.
    const before = messages.length;
    client.emit('managedSession.event', {
      sessionId: 'sess-1',
      event: { type: 'input.requested', payload: { request: { id: 'req-1', questions: [] } } },
    });
    expect(messages.length).toBe(before);
  });

  it('allow writes input.received(approved)', () => {
    const { coordinator, client } = setup();
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeEnd('tool-use-1'));
    void coordinator.respondToApproval('sess-1', 'req-2', 'allow');
    const sendEvent = client.sends.find((s) => s.method === 'managedSession.sendEvent');
    expect(sendEvent?.params).toMatchObject({
      sessionId: 'sess-1',
      event: { type: 'input.received', requestId: 'req-2', status: 'approved' },
    });
  });

  it('continue targets the SAME session; cancel calls cancel', () => {
    const { coordinator, client } = setup();
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeSpawn('tool-use-1'));
    coordinator.handleSubagentEvent('D:/ws', 'conv-1', makeEnd('tool-use-1'));

    void coordinator.continueSession('sess-1', 'add a risk section');
    const followUp = client.sends.find((s) => s.method === 'managedSession.sendEvent');
    expect(followUp?.params).toMatchObject({
      sessionId: 'sess-1',
      event: { type: 'user.message', content: [{ type: 'text', text: 'add a risk section' }] },
    });

    void coordinator.cancelSession('sess-1');
    const cancel = client.sends.find((s) => s.method === 'managedSession.cancel');
    expect(cancel?.params).toMatchObject({ sessionId: 'sess-1' });
  });
});

describe('B4: restart recovery', () => {
  it('reconcile queries get per binding; not_found → orphaned; unreachable → unavailable', async () => {
    const client = new FakeClient();
    client.getResponses.set('sess-1', { session: { id: 'sess-1', status: 'completed' } });
    client.getResponses.set('sess-2', { session: { id: 'sess-2', status: 'running' } });
    client.getResponses.set('sess-3', { session: { id: 'sess-3', status: 'running' } });

    // sess-3 get throws "not found"
    const origSend = client.send.bind(client);
    client.send = async (method: string, params?: unknown) => {
      if (method === 'managedSession.get' && (params as { sessionId?: string }).sessionId === 'sess-3') {
        throw new Error('Managed session not found: sess-3');
      }
      return origSend(method, params);
    };

    const messages: Array<{ root: string; conversationId: string; message: ChatMessage }> = [];
    const bindingChanges: ManagedChildBinding[] = [];
    const coordinator = new ManagedWorkCoordinator({
      client,
      projectKey: 'D:/ws',
      onMessage: (root, conversationId, message) => messages.push({ root, conversationId, message }),
      onBindingChange: (b) => bindingChanges.push(b),
      listArtifacts: () => [],
    });

    await coordinator.reconcile([
      makeBinding({ parentToolUseId: 't1', managedSessionId: 'sess-1' }),
      makeBinding({ parentToolUseId: 't2', managedSessionId: 'sess-2' }),
      makeBinding({ parentToolUseId: 't3', managedSessionId: 'sess-3' }),
    ]);

    const bySession = Object.fromEntries(bindingChanges.map((b) => [b.managedSessionId, b.status]));
    expect(bySession['sess-1']).toBe('completed');
    expect(bySession['sess-2']).toBe('running');
    expect(bySession['sess-3']).toBe('orphaned');
  });

  it('reconcile with a daemon that rejects everything → unavailable (no fabricated replacement)', async () => {
    const client = new FakeClient();
    client.send = async () => {
      throw new Error('connection refused');
    };
    const bindingChanges: ManagedChildBinding[] = [];
    const coordinator = new ManagedWorkCoordinator({
      client,
      projectKey: 'D:/ws',
      onMessage: () => {},
      onBindingChange: (b) => bindingChanges.push(b),
      listArtifacts: () => [],
    });
    await coordinator.reconcile([makeBinding()]);
    expect(bindingChanges[0]!.status).toBe('unavailable');
  });
});

describe('applyManagedMessage + helpers', () => {
  it('upserts by stable id', () => {
    const a: ChatMessage = {
      id: 'managed:t1', kind: 'subagent', role: 'system', createdAt: 1, status: 'running', agentType: 'managed-work',
    };
    const b: ChatMessage = {
      id: 'managed:t1', kind: 'subagent', role: 'system', createdAt: 2, status: 'done', agentType: 'managed-work', result: 'ok',
    };
    const next = applyManagedMessage([a], b);
    expect(next).toHaveLength(1);
    expect((next[0] as SubagentMessage).status).toBe('done');
    expect(applyManagedMessage([], a)).toEqual([a]);
  });

  it('buildSubagentMessage maps daemon statuses', () => {
    expect(buildSubagentMessage(makeBinding(), { status: 'awaiting_input' }).status).toBe('waiting');
    expect(buildSubagentMessage(makeBinding(), { status: 'completed' }).status).toBe('done');
    expect(buildSubagentMessage(makeBinding(), { status: 'failed' }).status).toBe('failed');
    expect(buildSubagentMessage(makeBinding(), { status: 'cancelled' }).status).toBe('cancelled');
  });
});
