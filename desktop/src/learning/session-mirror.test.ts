// session-mirror.ts：镜像触发时机与失败隔离（spec §7.4）。

import { describe, it, expect, vi } from 'vitest';

import type { CodeRunLifecycleObserver } from '../runtime/code-run-lifecycle';
import type { ConversationRecord } from '../host-adapter/conversation-history';
import type { LearningPort, LearningSessionProjection } from './learning-port';
import { createLearningMirrorObserver } from './session-mirror';

const SCOPE = {
  projectKey: 'ws-1',
  projectRoot: 'd:/repo',
  conversationId: 'sess-1',
  mode: 'code',
  runId: 'run-1',
  turnId: 'turn-1',
  startedAt: 1,
} as never;

function record(messages: readonly unknown[] = []): ConversationRecord {
  return {
    session: { id: 'sess-1', title: 'Demo', kind: 'code', mode: 'code', createdAt: 1, updatedAt: 2, turnCount: 1 } as never,
    messages: messages as never,
    draft: '',
  };
}

function fakePort() {
  const synced: LearningSessionProjection[] = [];
  const port = {
    syncSession: vi.fn(async (session: LearningSessionProjection) => {
      synced.push(session);
      return { ok: true, mirrored: true };
    }),
  } as unknown as LearningPort;
  return { synced, port };
}

function observer(deps: {
  port: () => LearningPort | null;
  resolve: () => unknown;
  log?: (m: string) => void;
}): CodeRunLifecycleObserver {
  return createLearningMirrorObserver(deps as never);
}

describe('createLearningMirrorObserver', () => {
  it('does nothing before the run reaches terminal', async () => {
    const { port, synced } = fakePort();
    const mirror = observer({ port: () => port, resolve: () => ({ record: record(), workspacePath: 'd:/repo' }) });
    mirror.onEvents(SCOPE, [] as never);
    await mirror.onRunStarted(SCOPE);
    expect(synced).toHaveLength(0);
  });

  it('mirrors the finished conversation with the workspace root and model', async () => {
    const { port, synced } = fakePort();
    const mirror = observer({
      port: () => port,
      resolve: () => ({
        record: record([
          { id: 'u1', turnId: 'u1', role: 'user', kind: 'text', text: 'q', createdAt: 1 },
          { id: 'a1', turnId: 'u1', role: 'assistant', kind: 'text', text: 'a', createdAt: 2 },
        ]),
        workspacePath: 'd:/repo',
        model: 'claude-sonnet-4',
      }),
    });
    await mirror.onRunTerminal(SCOPE, 'completed');
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({
      id: 'sess-1',
      title: 'Demo',
      workspace: { path: 'd:/repo' },
      model: 'claude-sonnet-4',
    });
  });

  it('does not mirror failed or cancelled runs', async () => {
    const { port, synced } = fakePort();
    const source = {
      record: record([
        { id: 'u1', turnId: 'u1', role: 'user', kind: 'text', text: 'q', createdAt: 1 },
        { id: 'a1', turnId: 'u1', role: 'assistant', kind: 'text', text: 'partial answer', createdAt: 2 },
      ]),
      workspacePath: 'd:/repo',
    };
    const mirror = observer({ port: () => port, resolve: () => source });
    await mirror.onRunTerminal(SCOPE, 'failed');
    await mirror.onRunTerminal(SCOPE, 'cancelled');
    expect(synced).toHaveLength(0);
  });

  it('skips conversations with nothing to recall', async () => {
    const { port, synced } = fakePort();
    const mirror = observer({ port: () => port, resolve: () => ({ record: record(), workspacePath: 'd:/repo' }) });
    await mirror.onRunTerminal(SCOPE, 'completed');
    expect(synced).toHaveLength(0);
  });

  it('skips when the finished conversation can no longer be resolved', async () => {
    const { port, synced } = fakePort();
    const mirror = observer({ port: () => port, resolve: () => null });
    await mirror.onRunTerminal(SCOPE, 'completed');
    expect(synced).toHaveLength(0);
  });

  it('never throws when the port is missing', async () => {
    const mirror = observer({ port: () => null, resolve: () => ({ record: record(), workspacePath: '' }) });
    await expect(mirror.onRunTerminal(SCOPE, 'completed')).resolves.toBeUndefined();
  });

  it('never throws when the mirror upload fails — the run lifecycle is unaffected', async () => {
    const logged: string[] = [];
    const port = { syncSession: async () => { throw new Error('adapter gone'); } } as unknown as LearningPort;
    const mirror = observer({
      port: () => port,
      resolve: () => ({ record: record([
        { id: 'u1', turnId: 'u1', role: 'user', kind: 'text', text: 'q', createdAt: 1 },
        { id: 'a1', turnId: 'u1', role: 'assistant', kind: 'text', text: 'a', createdAt: 2 },
      ]), workspacePath: 'd:/repo' }),
      log: (m) => logged.push(m),
    });
    await expect(mirror.onRunTerminal(SCOPE, 'completed')).resolves.toBeUndefined();
    expect(logged[0]).toContain('adapter gone');
  });

  it('reports a degrade result (ok:false) as a diagnostic', async () => {
    const logged: string[] = [];
    const port = { syncSession: async () => ({ ok: false, mirrored: false, error: 'storage root missing' }) } as unknown as LearningPort;
    const mirror = observer({
      port: () => port,
      resolve: () => ({ record: record([
        { id: 'u1', turnId: 'u1', role: 'user', kind: 'text', text: 'q', createdAt: 1 },
        { id: 'a1', turnId: 'u1', role: 'assistant', kind: 'text', text: 'a', createdAt: 2 },
      ]), workspacePath: 'd:/repo' }),
      log: (m) => logged.push(m),
    });
    await mirror.onRunTerminal(SCOPE, 'completed');
    expect(logged[0]).toContain('storage root missing');
  });

  it('never throws when resolve itself fails', async () => {
    const logged: string[] = [];
    const { port } = fakePort();
    const mirror = observer({
      port: () => port,
      resolve: () => { throw new Error('history map gone'); },
      log: (m) => logged.push(m),
    });
    await expect(mirror.onRunTerminal(SCOPE, 'completed')).resolves.toBeUndefined();
    expect(logged[0]).toContain('history map gone');
  });
});
