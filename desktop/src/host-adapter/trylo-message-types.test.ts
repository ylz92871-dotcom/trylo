// Trylo Desktop — Trylo message type unit tests. See
// the architecture doc §3 Phase 2 task #8.
//
// Tests run against `handleTryloRequest` with a stub context. The
// point is to lock down the contract: every request shape produces
// the matching response shape, the dispatcher throws on unknown
// types, and the side-effecting context methods are called with
// the right arguments.

import { describe, expect, it, vi } from 'vitest';
import {
  handleTryloRequest,
  type TryloHandlerContext,
} from './trylo-message-types';
import type {
  CreateSessionResponse,
  GetSessionsResponse,
  InitResponse,
  ModeChangedResponse,
  SetPermissionModeResponse,
  TestConnectionResponse,
  TryloMode,
  TryloRequest,
  TryloSession,
} from './trylo-api';

function makeSession(id: string, mode: TryloMode = 'chat'): TryloSession {
  return {
    id,
    title: `Session ${id}`,
    mode,
    createdAt: 0,
    updatedAt: 0,
    turnCount: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeContext(): { ctx: TryloHandlerContext; spies: Record<string, any> } {
  const sessions: TryloSession[] = [makeSession('s1', 'chat')];
  let activeId: string = sessions[0]!.id;

  const listSessions = vi.fn(() => sessions);
  const createSession = vi.fn(({ mode }: { mode: TryloMode }) => {
    const s = makeSession(`s${sessions.length + 1}`, mode);
    sessions.push(s);
    return s;
  });
  const setActiveSession = vi.fn((id: string) => {
    const exists = sessions.some((s) => s.id === id);
    if (exists) activeId = id;
    return exists;
  });
  const deleteSession = vi.fn((id: string) => {
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    sessions.splice(idx, 1);
    if (activeId === id) {
      activeId = sessions[0]?.id ?? '';
    }
    return true;
  });
  const getActiveSession = vi.fn(
    () => sessions.find((s) => s.id === activeId) ?? null,
  );
  const setMode = vi.fn((mode: TryloMode) => {
    const active = sessions.find((s) => s.id === activeId);
    if (active) {
      (active as { mode: TryloMode }).mode = mode;
    }
    return mode;
  });
  const setPermissionMode = vi.fn();
  const testConnection = vi.fn(async () => ({ ok: true, message: 'ok' }));
  const clearApiKey = vi.fn(async () => undefined);
  const clearVisionApiKey = vi.fn(async () => undefined);

  // The context interface is strict; the mocks are inferred as
  // generic `Mock<any[], unknown>`. Cast through `unknown`.
  const ctx = {
    workspaceRoot: 'D:/test/workspace',
    listSessions: listSessions as unknown as TryloHandlerContext['listSessions'],
    createSession: createSession as unknown as TryloHandlerContext['createSession'],
    setActiveSession: setActiveSession as unknown as TryloHandlerContext['setActiveSession'],
    deleteSession: deleteSession as unknown as TryloHandlerContext['deleteSession'],
    getActiveSession: getActiveSession as unknown as TryloHandlerContext['getActiveSession'],
    setMode: setMode as unknown as TryloHandlerContext['setMode'],
    setPermissionMode: setPermissionMode as unknown as TryloHandlerContext['setPermissionMode'],
    testConnection: testConnection as unknown as TryloHandlerContext['testConnection'],
    clearApiKey: clearApiKey as unknown as TryloHandlerContext['clearApiKey'],
    clearVisionApiKey: clearVisionApiKey as unknown as TryloHandlerContext['clearVisionApiKey'],
  };
  return {
    ctx,
    spies: {
      listSessions,
      createSession,
      setActiveSession,
      deleteSession,
      getActiveSession,
      setMode,
      setPermissionMode,
      testConnection,
      clearApiKey,
      clearVisionApiKey,
    },
  };
}

describe('handleTryloRequest', () => {
  it('init returns the active session and workspace root', async () => {
    const { ctx, spies } = makeContext();
    const res = (await handleTryloRequest({ type: 'init' }, ctx)) as InitResponse;
    expect(res.type).toBe('init');
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe('s1');
    expect(res.mode).toBe('chat');
    expect(res.workspaceRoot).toBe('D:/test/workspace');
    expect(spies.listSessions).toHaveBeenCalledTimes(0);
    expect(spies.getActiveSession).toHaveBeenCalledTimes(1);
  });

  it('init creates a session when none is active', async () => {
    const { ctx, spies } = makeContext();
    spies.getActiveSession.mockReturnValueOnce(null);
    const res = (await handleTryloRequest({ type: 'init' }, ctx)) as InitResponse;
    expect(res.sessionId).toBe('s2');
    expect(res.mode).toBe('chat');
    expect(spies.createSession).toHaveBeenCalledWith({ mode: 'chat' });
    expect(spies.setActiveSession).toHaveBeenCalledWith('s2');
  });

  it('createSession inserts and activates a new session', async () => {
    const { ctx, spies } = makeContext();
    const res = (await handleTryloRequest({ type: 'createSession' }, ctx)) as CreateSessionResponse;
    expect(res.type).toBe('createSession');
    expect(res.sessionId).toBe('s2');
    expect(spies.createSession).toHaveBeenCalledTimes(1);
    expect(spies.setActiveSession).toHaveBeenCalledWith('s2');
  });

  it('switchSession activates a known session', async () => {
    const { ctx, spies } = makeContext();
    ctx.createSession({ mode: 'agent' });
    const res = await handleTryloRequest(
      { type: 'switchSession', sessionId: 's2' },
      ctx,
    );
    expect(res).toEqual({ type: 'switchSession', ok: true });
    expect(spies.setActiveSession).toHaveBeenCalledWith('s2');
  });

  it('switchSession throws on unknown id', async () => {
    const { ctx } = makeContext();
    await expect(
      handleTryloRequest({ type: 'switchSession', sessionId: 'nope' }, ctx),
    ).rejects.toThrow(/unknown sessionId/);
  });

  it('deleteSession removes a known session', async () => {
    const { ctx, spies } = makeContext();
    const res = await handleTryloRequest(
      { type: 'deleteSession', sessionId: 's1' },
      ctx,
    );
    expect(res).toEqual({ type: 'deleteSession', ok: true });
    expect(spies.deleteSession).toHaveBeenCalledWith('s1');
    expect(spies.listSessions()).toHaveLength(0);
  });

  it('deleteSession throws on unknown id', async () => {
    const { ctx } = makeContext();
    await expect(
      handleTryloRequest({ type: 'deleteSession', sessionId: 'nope' }, ctx),
    ).rejects.toThrow(/unknown sessionId/);
  });

  it('getSessions returns the session list', async () => {
    const { ctx } = makeContext();
    const res = (await handleTryloRequest({ type: 'getSessions' }, ctx)) as GetSessionsResponse;
    expect(res.type).toBe('getSessions');
    expect(res.sessions).toHaveLength(1);
    expect(res.sessions[0]?.id).toBe('s1');
  });

  it('modeChanged updates the global mode and returns it', async () => {
    const { ctx, spies } = makeContext();
    const res = (await handleTryloRequest(
      { type: 'modeChanged', mode: 'agent' },
      ctx,
    )) as ModeChangedResponse;
    expect(res).toEqual({ type: 'modeChanged', ok: true, mode: 'agent' });
    expect(spies.setMode).toHaveBeenCalledWith('agent');
  });

  it('setPermissionMode stores the mode and returns it', async () => {
    const { ctx, spies } = makeContext();
    const res = (await handleTryloRequest(
      { type: 'setPermissionMode', permissionMode: 'acceptEdits' },
      ctx,
    )) as SetPermissionModeResponse;
    expect(res.permissionMode).toBe('acceptEdits');
    expect(spies.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
  });

  it('testConnection forwards to the context and reports ok=true', async () => {
    const { ctx, spies } = makeContext();
    const res = (await handleTryloRequest({ type: 'testConnection' }, ctx)) as TestConnectionResponse;
    expect(res).toEqual({ type: 'testConnection', ok: true, message: 'ok' });
    expect(spies.testConnection).toHaveBeenCalledTimes(1);
  });

  it('testConnection forwards the failure shape', async () => {
    const { ctx, spies } = makeContext();
    spies.testConnection.mockResolvedValueOnce({
      ok: false,
      message: 'no route',
    });
    const res = (await handleTryloRequest({ type: 'testConnection' }, ctx)) as TestConnectionResponse;
    expect(res.ok).toBe(false);
    expect(res.message).toBe('no route');
  });

  it('clearApiKey delegates and returns ok', async () => {
    const { ctx, spies } = makeContext();
    const res = await handleTryloRequest({ type: 'clearApiKey' }, ctx);
    expect(res).toEqual({ type: 'clearApiKey', ok: true });
    expect(spies.clearApiKey).toHaveBeenCalledTimes(1);
  });

  it('clearVisionApiKey delegates and returns ok', async () => {
    const { ctx, spies } = makeContext();
    const res = await handleTryloRequest({ type: 'clearVisionApiKey' }, ctx);
    expect(res).toEqual({ type: 'clearVisionApiKey', ok: true });
    expect(spies.clearVisionApiKey).toHaveBeenCalledTimes(1);
  });

  it('dispatcher throws on an unknown request type', async () => {
    const { ctx } = makeContext();
    const bogus = { type: 'noSuchType' } as unknown as TryloRequest;
    await expect(handleTryloRequest(bogus, ctx)).rejects.toThrow(
      /Unknown trylo request/,
    );
  });
});
