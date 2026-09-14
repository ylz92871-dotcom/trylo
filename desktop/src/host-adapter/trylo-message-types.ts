// Trylo Desktop — Trylo message type handlers. See ARCHITECTURE.md §3
// Phase 2 task #8.
//
// The six "simple" message types from the arch doc, plus three closely
// related ones we need to keep the iframe functional (switchSession,
// deleteSession, setPermissionMode). Each handler is a small pure
// function that takes a request and a context, and returns a response.
// Side effects (writing to a session store, calling out to the LLM,
// mutating Project State) are isolated to the context object so the
// handlers stay unit-testable in isolation.
//
// Phase 2 first batch:
//   init, createSession, switchSession, deleteSession, getSessions,
//   modeChanged, setPermissionMode, testConnection, clearApiKey,
//   clearVisionApiKey

import type {
  ClearApiKeyRequest,
  ClearApiKeyResponse,
  ClearVisionApiKeyRequest,
  ClearVisionApiKeyResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  GetSessionsRequest,
  GetSessionsResponse,
  InitRequest,
  InitResponse,
  ModeChangedRequest,
  ModeChangedResponse,
  SetPermissionModeRequest,
  SetPermissionModeResponse,
  SwitchSessionRequest,
  SwitchSessionResponse,
  TestConnectionRequest,
  TestConnectionResponse,
  TryloMode,
  TryloRequest,
  TryloResponse,
  TryloSession,
} from './trylo-api';
import type { FilePath } from './types';

// ── Context (DI surface) ──────────────────────────────────────────────────
//
// The handlers do not import HostAdapter directly. They receive a
// context with the side-effecting operations they need. In production
// the context wraps HostAdapter + Project State; in tests it is a
// plain object with stubs.

export interface TryloHandlerContext {
  readonly workspaceRoot: FilePath;
  /** Read all sessions. */
  listSessions(): readonly TryloSession[];
  /** Insert a new session and return it. */
  createSession(input: { mode: TryloMode }): TryloSession;
  /** Mark a session as the active one. Returns false if the id is unknown. */
  setActiveSession(sessionId: string): boolean;
  /** Remove a session. Returns false if the id is unknown. */
  deleteSession(sessionId: string): boolean;
  /** Get the active session. */
  getActiveSession(): TryloSession | null;
  /** Set the global mode. Returns the new mode. */
  setMode(mode: TryloMode): TryloMode;
  /** Set the permission mode for the next agent run. */
  setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'): void;
  /** Test the LLM route (CC CLI or direct API). */
  testConnection(): Promise<{ ok: boolean; message: string }>;
  /** Clear the primary API key. */
  clearApiKey(): Promise<void>;
  /** Clear the vision API key. */
  clearVisionApiKey(): Promise<void>;
}

// ── Dispatch ──────────────────────────────────────────────────────────────

/**
 * Route a request to its handler. The `try`/`catch` is intentionally
 * here at the dispatch level so handlers can throw plain Errors and
 * the iframe sees a uniform error shape (rejected Promise with
 * `Error.message`).
 */
export async function handleTryloRequest(
  req: TryloRequest,
  ctx: TryloHandlerContext,
): Promise<TryloResponse> {
  switch (req.type) {
    case 'init':
      return handleInit(req, ctx);
    case 'createSession':
      return handleCreateSession(req, ctx);
    case 'switchSession':
      return handleSwitchSession(req, ctx);
    case 'deleteSession':
      return handleDeleteSession(req, ctx);
    case 'getSessions':
      return handleGetSessions(req, ctx);
    case 'modeChanged':
      return handleModeChanged(req, ctx);
    case 'setPermissionMode':
      return handleSetPermissionMode(req, ctx);
    case 'testConnection':
      return handleTestConnection(req, ctx);
    case 'clearApiKey':
      return handleClearApiKey(req, ctx);
    case 'clearVisionApiKey':
      return handleClearVisionApiKey(req, ctx);
    default: {
      // Exhaustiveness check. If a new variant is added to
      // TryloRequest and not handled here, TypeScript will fail the
      // build at this line.
      const _exhaustive: never = req;
      throw new Error(`Unknown trylo request: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────

function handleInit(_req: InitRequest, ctx: TryloHandlerContext): InitResponse {
  const active = ctx.getActiveSession();
  if (active === null) {
    // No active session — create one. The legacy webview expects an
    // active session on init, so we lazily create one with the
    // default mode (chat).
    const session = ctx.createSession({ mode: 'chat' });
    ctx.setActiveSession(session.id);
    return {
      type: 'init',
      ok: true,
      sessionId: session.id,
      mode: 'chat',
      workspaceRoot: ctx.workspaceRoot,
    };
  }
  return {
    type: 'init',
    ok: true,
    sessionId: active.id,
    mode: active.mode,
    workspaceRoot: ctx.workspaceRoot,
  };
}

function handleCreateSession(
  _req: CreateSessionRequest,
  ctx: TryloHandlerContext,
): CreateSessionResponse {
  const session = ctx.createSession({ mode: ctx.getActiveSession()?.mode ?? 'chat' });
  ctx.setActiveSession(session.id);
  return { type: 'createSession', ok: true, sessionId: session.id };
}

function handleSwitchSession(
  req: SwitchSessionRequest,
  ctx: TryloHandlerContext,
): SwitchSessionResponse {
  const ok = ctx.setActiveSession(req.sessionId);
  if (!ok) {
    throw new Error(`switchSession: unknown sessionId ${req.sessionId}`);
  }
  return { type: 'switchSession', ok: true };
}

function handleDeleteSession(
  req: DeleteSessionRequest,
  ctx: TryloHandlerContext,
): DeleteSessionResponse {
  const ok = ctx.deleteSession(req.sessionId);
  if (!ok) {
    throw new Error(`deleteSession: unknown sessionId ${req.sessionId}`);
  }
  return { type: 'deleteSession', ok: true };
}

function handleGetSessions(
  _req: GetSessionsRequest,
  ctx: TryloHandlerContext,
): GetSessionsResponse {
  return { type: 'getSessions', sessions: ctx.listSessions() };
}

function handleModeChanged(
  req: ModeChangedRequest,
  ctx: TryloHandlerContext,
): ModeChangedResponse {
  const mode = ctx.setMode(req.mode);
  return { type: 'modeChanged', ok: true, mode };
}

function handleSetPermissionMode(
  req: SetPermissionModeRequest,
  ctx: TryloHandlerContext,
): SetPermissionModeResponse {
  ctx.setPermissionMode(req.permissionMode);
  return { type: 'setPermissionMode', ok: true, permissionMode: req.permissionMode };
}

async function handleTestConnection(
  _req: TestConnectionRequest,
  ctx: TryloHandlerContext,
): Promise<TestConnectionResponse> {
  const result = await ctx.testConnection();
  return { type: 'testConnection', ok: result.ok, message: result.message };
}

async function handleClearApiKey(
  _req: ClearApiKeyRequest,
  ctx: TryloHandlerContext,
): Promise<ClearApiKeyResponse> {
  await ctx.clearApiKey();
  return { type: 'clearApiKey', ok: true };
}

async function handleClearVisionApiKey(
  _req: ClearVisionApiKeyRequest,
  ctx: TryloHandlerContext,
): Promise<ClearVisionApiKeyResponse> {
  await ctx.clearVisionApiKey();
  return { type: 'clearVisionApiKey', ok: true };
}
