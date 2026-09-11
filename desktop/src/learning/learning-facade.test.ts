// learning-facade.ts：方法转发 + apply 的失败关闭（spec §7.5 / arch §6.3）。
// 用 fake ServicesClient，不经过 Tauri。

import { describe, it, expect, vi } from 'vitest';

import { ServiceRequestError } from '../services-host/services-client';
import { createLearningFacade, resolveHermesMcpArgs } from './learning-facade';
import { createNullLearningPort } from './learning-port';

function fakeClient() {
  const calls: { method: string; params?: unknown }[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === 'learning.mcpArgs') {
      return { ok: true, profile: (params as { profile?: string })?.profile ?? 'normal', arg: ['--mcp-config', '{}'], warning: null };
    }
    return { ok: true };
  });
  return { calls, client: { request } as never };
}

describe('createLearningFacade', () => {
  it('forwards each read-only query to its method name', async () => {
    const { calls, client } = fakeClient();
    const port = createLearningFacade(client);

    await port.health();
    await port.memorySnapshot();
    await port.skills({ op: 'view', name: 'demo' });
    await port.listPending();
    await port.pendingDetail({ subsystem: 'skills', id: 'p1' });
    await port.discardPending({ subsystem: 'skills', id: 'p1' });
    await port.listPendingBackups();
    await port.rollbackPending({ snapshotId: 'snap-1' });

    expect(calls.map((c) => c.method)).toEqual([
      'learning.health',
      'learning.memorySnapshot',
      'learning.skills',
      'learning.pendingList',
      'learning.pendingDetail',
      'learning.pendingDiscard',
      'learning.pendingBackupList',
      'learning.pendingRollback',
    ]);
    expect(calls.at(2)?.params).toEqual({ op: 'view', name: 'demo' });
  });

  it('forwards the 3C learning-loop methods', async () => {
    const { calls, client } = fakeClient();
    const port = createLearningFacade(client);

    await port.reviewImplicit({ workspaceRoot: 'd:/repo', sessionId: 's1' });
    await port.learnExplicit({ workspaceRoot: 'd:/repo', sessionId: 's1', learnRequest: 'make a skill' });
    await port.runStatus({ workspaceRoot: 'd:/repo' });
    await port.searchHistory({ queries: ['q'] });

    expect(calls.map((c) => c.method)).toEqual([
      'learning.reviewImplicit',
      'learning.learnExplicit',
      'learning.runStatus',
      'learning.historySearch',
    ]);
  });

  it('forwards the upstream journey and L4/L5/L6 methods', async () => {
    const { calls, client } = fakeClient();
    const port = createLearningFacade(client);

    await port.graphSummary();
    await port.scanQuality({ scope: { skillNames: ['demo'] } });
    await port.mineHistory({ workspaceRoot: 'd:/repo', workspaceLabel: 'repo' });
    await port.manageJobs({ action: 'list' });

    expect(calls.map((c) => c.method)).toEqual([
      'learning.graphSummary',
      'learning.qualityScan',
      'learning.historyMine',
      'learning.jobs',
    ]);
  });

  it('learnExplicit requires a /learn request', async () => {
    const { calls, client } = fakeClient();
    await expect(
      createLearningFacade(client).learnExplicit({ workspaceRoot: 'd:/repo', sessionId: 's1', learnRequest: '' }),
    ).rejects.toThrow(/learn request/);
    expect(calls).toHaveLength(0);
  });

  it('forwards the legacy import plan/commit and validates the source', async () => {
    const { calls, client } = fakeClient();
    const port = createLearningFacade(client);

    await port.planLegacyImport();
    await port.commitLegacyImport({ source: 'C:/legacy/local.trylo-code' });
    await expect(port.commitLegacyImport({ source: '' })).rejects.toThrow(/source path/);

    expect(calls.map((c) => c.method)).toEqual(['learning.importPlan', 'learning.importCommit']);
    expect(calls[1]!.params).toEqual({ source: 'C:/legacy/local.trylo-code' });
  });

  it('mcpArgs sends the requested profile', async () => {
    const { client } = fakeClient();
    const result = await createLearningFacade(client).mcpArgs('history');
    expect(result).toMatchObject({ ok: true, profile: 'history' });
  });

  it('session mirror methods send the projection(s) verbatim', async () => {
    const { calls, client } = fakeClient();
    const port = createLearningFacade(client);
    const session = { id: 's1', title: 't', workspace: { path: 'd:/repo' }, model: 'm', turns: [] };

    await port.syncSession(session);
    await port.rebuildSessions([session]);
    await port.flushSessions();

    expect(calls.map((c) => c.method)).toEqual(['session.sync', 'session.rebuild', 'session.flush']);
    expect(calls.at(0)?.params).toEqual({ session });
    expect(calls.at(1)?.params).toEqual({ sessions: [session] });
  });

  it('applyPending is fail-closed: no expectedHash ⇒ never leaves the renderer', async () => {
    const { calls, client } = fakeClient();
    const port = createLearningFacade(client);

    await expect(port.applyPending({ subsystem: 'skills', id: 'p1', expectedHash: '' })).rejects.toThrow(/expectedHash/);
    await expect(port.applyPending({ subsystem: 'skills', id: '', expectedHash: 'sha256:abc' })).rejects.toThrow(/pendingId/);
    await expect(port.applyPending({ subsystem: 'invalid' as never, id: 'p1', expectedHash: 'sha256:abc' })).rejects.toThrow(/subsystem/);
    expect(calls).toHaveLength(0);
  });

  it('applyPending forwards id + expectedHash + reason', async () => {
    const { calls, client } = fakeClient();
    await createLearningFacade(client).applyPending({ subsystem: 'memory', id: 'p1', expectedHash: 'sha256:abc', reason: 'reviewed' });
    expect(calls[0]).toEqual({
      method: 'learning.pendingApply',
      params: { subsystem: 'memory', id: 'p1', expectedHash: 'sha256:abc', reason: 'reviewed' },
    });
  });

  it('rollbackPending requires a snapshot id from the backup list', async () => {
    const { calls, client } = fakeClient();
    const port = createLearningFacade(client);
    await expect(port.rollbackPending({ snapshotId: '' })).rejects.toThrow(/snapshotId/);
    expect(calls).toHaveLength(0);
  });

  it('lets a degrade answer (ok:false) resolve — Hermes missing is not an error', async () => {
    const client = { request: vi.fn(async () => ({ ok: false, error: 'Hermes not installed' })) } as never;
    const port = createLearningFacade(client);
    await expect(port.memorySnapshot()).resolves.toEqual({ ok: false, error: 'Hermes not installed' });
  });
});

describe('resolveHermesMcpArgs', () => {
  it('returns the args when Hermes is available', async () => {
    const args = await resolveHermesMcpArgs(createLearningFacade(fakeClient().client), 'learning');
    expect(args).toEqual(['--mcp-config', '{}']);
  });

  it('degrades to [] when the host answers ok:false', async () => {
    const client = { request: vi.fn(async () => ({ ok: false, profile: 'normal', arg: [], warning: 'missing' })) } as never;
    await expect(resolveHermesMcpArgs(createLearningFacade(client), 'normal')).resolves.toEqual([]);
  });

  it('degrades to [] on a transport failure (host down)', async () => {
    const client = { request: vi.fn(async () => { throw new ServiceRequestError('NOT_CONNECTED', 'host gone'); }) } as never;
    await expect(resolveHermesMcpArgs(createLearningFacade(client), 'normal')).resolves.toEqual([]);
  });

  it('rethrows anything that is not a transport failure', async () => {
    const client = { request: vi.fn(async () => { throw new Error('boom'); }) } as never;
    await expect(resolveHermesMcpArgs(createLearningFacade(client), 'normal')).rejects.toThrow('boom');
  });
});

describe('createNullLearningPort', () => {
  it('degrades every call explicitly — never a silent success', async () => {
    const port = createNullLearningPort();
    expect((await port.health()).ok).toBe(false);
    expect((await port.mcpArgs('normal')).arg).toEqual([]);
    expect((await port.memorySnapshot()).ok).toBe(false);
    expect((await port.skills({ op: 'list' })).ok).toBe(false);
    expect((await port.syncSession({ id: 's', title: '', workspace: { path: '' }, turns: [] })).mirrored).toBe(false);
    expect((await port.rebuildSessions([])).ok).toBe(false);
    expect((await port.listPending()).pending).toEqual([]);
    expect((await port.pendingDetail({ subsystem: 'skills', id: 'p' })).ok).toBe(false);
    expect((await port.applyPending({ subsystem: 'skills', id: 'p', expectedHash: 'h' })).ok).toBe(false);
    expect((await port.discardPending({ subsystem: 'skills', id: 'p' })).ok).toBe(false);
    expect((await port.listPendingBackups()).backups).toEqual([]);
    expect((await port.rollbackPending({ snapshotId: 's' })).ok).toBe(false);
    await expect(port.flushSessions()).resolves.toBeTruthy();
    expect((await port.runStatus()).active).toBe(false);
    expect((await port.searchHistory({ queries: [] })).ok).toBe(false);
    expect((await port.graphSummary()).ok).toBe(false);
    expect((await port.scanQuality()).candidates).toEqual([]);
    expect((await port.mineHistory({ workspaceRoot: 'd:/repo' })).ok).toBe(false);
    expect((await port.manageJobs()).ok).toBe(false);
    expect((await port.planLegacyImport()).candidates).toEqual([]);
    expect((await port.commitLegacyImport({ source: 'x' })).ok).toBe(false);
  });
});
